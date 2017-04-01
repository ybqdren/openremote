/*
 * Copyright 2017, OpenRemote Inc.
 *
 * See the CONTRIBUTORS.txt file in the distribution for a
 * full listing of individual contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */
package org.openremote.manager.server.asset;

import org.apache.camel.builder.RouteBuilder;
import org.openremote.container.Container;
import org.openremote.container.ContainerService;
import org.openremote.container.message.MessageBrokerService;
import org.openremote.container.message.MessageBrokerSetupService;
import org.openremote.manager.server.agent.AgentService;
import org.openremote.manager.server.datapoint.AssetDatapointService;
import org.openremote.manager.server.rules.RulesService;
import org.openremote.model.AttributeEvent;
import org.openremote.model.AttributeState;
import org.openremote.model.asset.*;
import org.openremote.model.asset.thing.ThingAttribute;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

import static org.openremote.agent3.protocol.Protocol.SENSOR_TOPIC;

/**
 * Receives {@link AttributeEvent}s and processes them.
 * <p>
 * {@link AttributeEvent}s can come from various sources:
 * <ul>
 * <li>Protocol ({@link org.openremote.agent3.protocol.AbstractProtocol#onSensorUpdate})</li>
 * <li>User/Client initiated ({@link #updateAttributeValue})</li>
 * <li>Rules ({@link org.openremote.model.rules.Assets#dispatch})</li>
 * </ul>
 * The {@link AttributeEvent}s are first validated (link and value type checking) then they are
 * converted into {@link AssetUpdate} messages which are then passed through the processing chain of consumers.
 * <p>
 * The regular processing chain is:
 * <ul>
 * <li>{@link RulesService}</li>
 * <li>{@link AgentService}</li>
 * <li>{@link AssetStorageService}</li>
 * <li>{@link AssetDatapointService}</li>
 * </ul>
 * <em>Rules Service processing logic</em>
 * <p>
 * Checks if attribute is {@link AssetAttribute#isRulesFact} or {@link AssetAttribute#isRulesEvent}, and if
 * it does then the message is passed through the rule engines that are in scope for the asset. Rules have the ability
 * to change the status and new value of {@link AssetUpdate} messages to either prevent them from progressing through
 * the processing chain or changing the value that progresses through the processing chain. Rules can also set a status
 * of {@link AssetUpdate.Status#RULES_HANDLED} which means that the message shouldn't be processed by any more rule
 * engines but it should continue through the processing chain. For {@link org.openremote.model.rules.AssetEvent}
 * messages, they are inserted in the rules sessions in scope and expired automatically either by a) the rules session
 * if no time-pattern can possibly match the event timestamp anymore or b) by the rules service if the event lifetime
 * set in {@link RulesService#RULES_EVENT_EXPIRES} is reached or c) by the rules service if the event lifetime set in
 * the attribute {@link AssetMeta#RULES_EVENT_EXPIRES} is reached.
 * <p>
 * <em>Agent service processing logic</em>
 * <p>
 * When the attribute event came from a Protocol (i.e. generated by a call from
 * {@link org.openremote.agent3.protocol.AbstractProtocol#onSensorUpdate} then
 * the agent service will ignore the message and just pass it onto the next consumer.
 * <p>
 * When the attribute event came from any other source then the agent service will check if it relates
 * to a {@link AssetType#THING} and if so it will check if the attribute is linked to an {@link AssetType#AGENT}.
 * If it is not linked to an agent then it ignores the message and just passes it to the next consumer. If it
 * is linked to an agent and the agent link is invalid then the message status is set to
 * {@link AssetUpdate.Status#ERROR} and the message will not be able to progress through the processing chain.
 * <p>
 * If the message is for a valid linked agent then an {@link AttributeEvent} is sent on the
 * {@link org.openremote.agent3.protocol.AbstractProtocol#ACTUATOR_TOPIC} which the protocol will receive in
 * {@link org.openremote.agent3.protocol.AbstractProtocol#sendToActuator} for execution on an actual device or
 * service 'things'.
 * <p>
 * This means that a protocol implementation is responsible for producing a new {@link AttributeEvent} to
 * indicate to the system that the attribute value has/has not changed. The protocol should know best when to
 * do this and will vary from protocol to protocol; some 'things' might respond to an actuator command immediately
 * with a new sensor read, or they might send a separate sensor changed message or both or neither (fire and
 * forget). The protocol must decide what the best course of action is based on the 'things' it communicates with
 * and the transport layer it uses etc.
 * <p>
 * <em>Asset Storage Service processing logic</em>
 * <p>
 * Always tries to persist the attribute value in the DB and allows the message to continue if the commit was
 * successful.
 * <p>
 * <em>Asset Datapoint Service processing logic</em>
 * <p>
 * Checks if attribute has {@link org.openremote.model.asset.AssetMeta#STORE_DATA_POINTS} meta item with a value of true
 * and if it does then the {@link AttributeEvent} is stored in a time series DB. Then allows the message to continue
 * if the commit was successful. TODO Should the datapoint service only store northbound updates?
 */
public class AssetProcessingService extends RouteBuilder implements ContainerService {

    private static final Logger LOG = Logger.getLogger(AssetProcessingService.class.getName());

    protected RulesService rulesService;
    protected AgentService agentService;
    protected AssetStorageService assetStorageService;
    protected AssetDatapointService assetDatapointService;
    protected MessageBrokerService messageBrokerService;

    final protected List<Consumer<AssetUpdate>> processors = new ArrayList<>();

    @Override
    public void init(Container container) throws Exception {
        rulesService = container.getService(RulesService.class);
        agentService = container.getService(AgentService.class);
        assetStorageService = container.getService(AssetStorageService.class);
        assetDatapointService = container.getService(AssetDatapointService.class);
        messageBrokerService = container.getService(MessageBrokerService.class);

        processors.add(rulesService);
        processors.add(agentService);
        processors.add(assetStorageService);
        processors.add(assetDatapointService);

        container.getService(MessageBrokerSetupService.class).getContext().addRoutes(this);
    }

    @Override
    public void start(Container container) throws Exception {

    }

    @Override
    public void stop(Container container) throws Exception {

    }

    @Override
    public void configure() throws Exception {

        // Sensor updates are processed first by rules, then stored in the asset and datapoint databases
        from(SENSOR_TOPIC)
            .filter(body().isInstanceOf(AttributeEvent.class))
            .process(exchange -> processSensorUpdate(exchange.getIn().getBody(AttributeEvent.class)));
    }

    /**
     * This is the entry point for any attribute value change event in the entire system. This deals
     * with single attribute value changes and pushes them through the attribute event processing chain
     * where each consumer is given the opportunity to consume the event or allow it progress to the
     * next consumer {@link AssetUpdate.Status}.
     * <p>
     * NOTE: An attribute value can be changed during Asset CRUD but this does not come through
     * this route but is handled separately see {@link AssetResourceImpl}. Any attribute values
     * assigned during Asset CRUD can be thought of as the attributes initial value and is subject
     * to change by the following actors (depending on attribute meta etc.) all actors use this
     * entry point to initiate an attribute value change:
     * <p>
     * Rules
     * Protocol
     * User
     *
     * @param attributeEvent
     */
    public void updateAttributeValue(AttributeEvent attributeEvent) {

        // Check this event relates to a valid asset
        ServerAsset asset = assetStorageService.find(attributeEvent.getEntityId(), true);

        if (asset == null) {
            LOG.warning("Processing client update failed, asset not found: " + attributeEvent);
            return;
        }

        // Prevent editing of individual agent attributes
        if (asset.getWellKnownType() == AssetType.AGENT) {
            throw new IllegalArgumentException(
                "Agent attributes can not be updated individually, update the whole asset instead: " + asset
            );
        }

        // Pass attribute event through the processing chain
        LOG.fine("Processing client " + attributeEvent + " for: " + asset);
        AssetAttributes attributes = new AssetAttributes(asset);
        AssetAttribute attribute = attributes.get(attributeEvent.getAttributeName());

        if (attribute == null) {
            LOG.warning("Ignoring " + attributeEvent + ", attribute doesn't exist on asset: " + asset);
            return;
        }

        // Prevent editing of read only attributes
        // TODO This also means a rule RHS can't write a read-only attribute with Assets#dispatch!
        if (attribute.isReadOnly()) {
            LOG.warning("Ignoring " + attributeEvent + ", attribute is read-only in: " + asset);
            return;
        }

        processUpdate(asset, attribute, attributeEvent, false);
    }

    /**
     * We get here if a protocol pushes a sensor update message.
     *
     * @param attributeEvent
     */
    protected void processSensorUpdate(AttributeEvent attributeEvent) {
        ServerAsset thing = assetStorageService.find(attributeEvent.getEntityId(), true);
//        // Must reference a thing asset
//
//        if (thing == null || thing.getWellKnownType() != THING) {
//            LOG.fine("Ignoring " + attributeEvent + ", not a thing: " + thing);
//            return;
//        }

        LOG.fine("Processing sensor " + attributeEvent + " for thing: " + thing);

        // Get the attribute and check it is actually linked to an agent (although the
        // event comes from a Protocol, we can not assume that the attribute is still linked,
        // consider a protocol that receives a batch of messages because a gateway was offline
        // for a day)
        AssetAttributes attributes = new AssetAttributes(thing);

        // Look for a matching thing attribute
        AssetAttribute attribute = attributes.get(attributeEvent.getAttributeName());

        // Convert this into a thing attribute
        ThingAttribute thingAttribute = ThingAttribute.get(attribute, agentService.getProtocolConfigurationResolver());

        if (thingAttribute == null) {
            LOG.warning("Processing sensor update failed attribute not linked to an agent: " + attributeEvent);
            return;
        }

        // Protocols can write to readonly attributes (i.e. sensor attributes)
        // So no need to check readonly flag

        processUpdate(thing, thingAttribute, attributeEvent, true);
    }

    protected void processUpdate(ServerAsset asset,
                                 AbstractAssetAttribute attribute,
                                 AttributeEvent attributeEvent,
                                 boolean northbound) {
        // Ensure timestamp of event is not in the future as that would essentially block access to
        // the attribute until after that time (maybe that is desirable behaviour)
        // Allow a leniency of 1s
        if (attributeEvent.getTimestamp() - System.currentTimeMillis() > 1000) {
            // TODO: Decide how to handle update events in the future - ignore or change timestamp
            LOG.warning("Ignoring " + attributeEvent + ", event-time is in the future in:" + asset);
            return;
        }

        // Hold on to existing attribute state so we can use it during processing
        AttributeEvent lastStateEvent = attribute.getStateEvent();

        // Check the last update timestamp of the attribute, ignoring any event that is older than last update
        // TODO: This means we drop out-of-sequence events, we might need better at-least-once handling
        if (lastStateEvent.getTimestamp() >= 0 && attributeEvent.getTimestamp() <= lastStateEvent.getTimestamp()) {
            LOG.warning("Ignoring " + attributeEvent + ", event-time is older than attribute's last state " + lastStateEvent + " in: " + asset);
            return;
        }

        // Set new value and event timestamp on attribute, thus validating any attribute constraints
        try {
            attribute.setValue(attributeEvent.getAttributeState().getValue(), attributeEvent.getTimestamp());
        } catch (IllegalArgumentException ex) {
            LOG.log(Level.WARNING, "Ignoring " + attributeEvent + ", attribute constraint violation in: " + asset, ex);
            return;
        }

        processUpdate(
            new AssetUpdate(
                asset,
                attribute,
                lastStateEvent.getValue(),
                lastStateEvent.getTimestamp(),
                northbound)
        );
    }

    protected void processUpdate(AssetUpdate assetUpdate) {
        try {
            LOG.fine(">>> Processing start: " + assetUpdate);
            processorLoop:
            for (Consumer<AssetUpdate> processor : processors) {
                try {
                    LOG.fine("Processor " + processor + " accepts: " + assetUpdate);
                    processor.accept(assetUpdate);
                } catch (Throwable t) {
                    LOG.log(Level.SEVERE, "Asset update consumer '" + processor + "' threw an exception whilst consuming the update:" + assetUpdate, t);
                    assetUpdate.setStatus(AssetUpdate.Status.ERROR);
                    assetUpdate.setError(t);
                }

                switch (assetUpdate.getStatus()) {
                    case HANDLED:
                        LOG.fine("Processor " + processor + " finally handled: " + assetUpdate);
                        break processorLoop;
                    case ERROR:
                        // TODO Better error handling, not sure we need rewind?
                        LOG.severe("Asset update status is '" + assetUpdate.getStatus() + "' cannot continue processing");
                        assetUpdate.setStatus(AssetUpdate.Status.COMPLETED);
                        throw new RuntimeException("Processor " + processor + " error: " + assetUpdate, assetUpdate.getError());
                }
            }
            assetUpdate.setStatus(AssetUpdate.Status.COMPLETED);
        } finally {
            LOG.fine("<<< Processing complete: " + assetUpdate);
        }
    }

    @Override
    public String toString() {
        return getClass().getSimpleName() + "{" +
            '}';
    }
}
