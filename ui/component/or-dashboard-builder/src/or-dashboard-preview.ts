import manager, {DefaultColor4, DefaultColor5} from "@openremote/core";
import {css, html, LitElement, TemplateResult, unsafeCSS} from "lit";
import {customElement, property, state} from "lit/decorators.js";
import {style} from "./style";
import "./or-dashboard-widget";
import {debounce} from "lodash";
import {
    DashboardGridItem,
    DashboardScalingPreset,
    DashboardScreenPreset,
    DashboardTemplate,
    DashboardWidget
} from "@openremote/model";
import { getActivePreset } from "./index";
import {InputType, OrInputChangedEvent} from "@openremote/or-mwc-components/or-mwc-input";
import {repeat} from 'lit/directives/repeat.js';
import {GridItemHTMLElement, GridStack, GridStackElement, GridStackNode} from "gridstack";
import {showSnackbar} from "@openremote/or-mwc-components/or-mwc-snackbar";
import { i18next } from "@openremote/or-translate";
import { when } from "lit/directives/when.js";
import { cache } from "lit/directives/cache.js";

// TODO: Add webpack/rollup to build so consumers aren't forced to use the same tooling
const gridcss = require('gridstack/dist/gridstack.min.css');
const extracss = require('gridstack/dist/gridstack-extra.css');

//language=css
const editorStyling = css`
    
    #view-options {
        padding: 24px;
        display: flex;
        justify-content: center;
        align-items: center;
    }
    /* Margins on view options */
    #fit-btn { margin-right: 10px; }
    #view-preset-select { margin-left: 20px; }
    #width-input { margin-left: 20px; }
    #height-input { margin-left: 10px; }
    #rotate-btn { margin-left: 10px; }
    
    .maingridContainer {
        position: absolute;
        padding-bottom: 32px;
    }
    .maingridContainer__fullscreen {
        width: 100%;
    }
    
    .maingrid {
        border: 3px solid #909090;
        background: #FFFFFF;
        border-radius: 8px;
        overflow-x: hidden;
        overflow-y: scroll;
        padding: 4px;
        z-index: 0;
    }
    .maingrid__fullscreen {
        border: none;
        background: transparent;
        border-radius: 0;
        overflow-x: hidden;
        overflow-y: scroll;
        height: 100% !important; /* To override .maingrid */
        width: 100% !important; /* To override .maingrid */
        padding: 0;
        /*pointer-events: none;*/
        position: relative;
        z-index: 0;
    }
    .maingrid__disabled {
        pointer-events: none;
        opacity: 40%;
    }
    .grid-stack-item-content {
        background: white;
        box-sizing: border-box;
        border: 1px solid var(--or-app-color5, ${unsafeCSS(DefaultColor5)});
        border-radius: 4px;
        overflow: hidden !important;
    }
    .grid-stack-item-content__active {
        border: 2px solid var(--or-app-color4, ${unsafeCSS(DefaultColor4)});
        margin: -1px !important; /* to compromise with the extra pixel of border. */
    }
    
    /* Grid lines on the background of the grid */
    .grid-element {
        background-image:
                linear-gradient(90deg, #E0E0E0, transparent 1px),
                linear-gradient(90deg, transparent calc(100% - 1px), #E0E0E0),
                linear-gradient(#E0E0E0, transparent 1px),
                linear-gradient(transparent calc(100% - 1px), #E0E0E0 100%);
    }
`

/* -------------------------------------------------- */

export interface ORGridStackNode extends GridStackNode {
    widgetTypeId: string;
}
export interface DashboardPreviewSize {
    displayName: string;
    width?: number,
    height?: number,
}

/* ------------------------------------------------------------ */

@customElement("or-dashboard-preview")
export class OrDashboardPreview extends LitElement {

    // Monitoring the changes in the template, save the changes to this.latestChanges,
    // so we can check afterwards which changes are made. Used for
    @property({ hasChanged(oldValue, newValue) { return JSON.stringify(oldValue) != JSON.stringify(newValue); }})
    set template(newValue: DashboardTemplate) {
        const currentValue = this._template;
        if(currentValue != undefined) {
            const changes = {
                changedKeys: Object.keys(newValue).filter(key => (JSON.stringify(newValue[key as keyof DashboardTemplate]) !== JSON.stringify(currentValue[key as keyof DashboardTemplate]))),
                oldValue: currentValue,
                newValue: newValue
            };
            this._template = JSON.parse(JSON.stringify(newValue));
            this.latestChanges = changes;
            this.requestUpdate("template", currentValue);

        // If there is no value yet, do initial setup:
        } else if(newValue != undefined) {
            this._template = newValue;
            this.setupGrid(false, false);
        }
    }

    private _template?: DashboardTemplate;

    get template() {
        return this._template!;
    }

    /* ------------------------ */

    @property() // Optional alternative for template
    protected readonly dashboardId?: string;

    @property() // Normally manager.displayRealm
    protected realm?: string;

    @property({type: Object})
    protected selectedWidget: DashboardWidget | undefined;

    @property()
    protected editMode: boolean = false;

    @property() // For example when no permission
    protected readonly: boolean = true;

    @property()
    protected previewWidth?: string;

    @property()
    protected previewHeight?: string;

    @property()
    protected previewZoom: number = 1;

    @property()
    protected previewSize?: DashboardPreviewSize;

    @property()
    protected availablePreviewSizes?: DashboardPreviewSize[];

    @property()
    protected fullscreen: boolean = true;

    @property() // Property that, when toggled on, shows a "loading" state for 200ms, and then renders the component again.
    protected rerenderPending: boolean = false;

    /* -------------- */

    @state()
    protected grid?: GridStack;

    @state() // State where the changes of the template are saved temporarily (for comparison with incoming data)
    protected latestChanges?: {
        changedKeys: string[],
        oldValue: DashboardTemplate,
        newValue: DashboardTemplate
    }

    @state() // Records time a user is dragging
    protected latestDragWidgetStart?: Date;

    @state()
    protected activePreset?: DashboardScreenPreset;

    @state()
    private rerenderActive: boolean = false;


    /* ------------------------------------------- */

    // Using constructor to set initial values
    constructor() {
        super();
        if(!this.realm) { this.realm = manager.displayRealm; }
        if(!this.availablePreviewSizes) {
            this.availablePreviewSizes = [
                { displayName: "4k Television", width: 3840, height: 2160 },
                { displayName: "Desktop", width: 1920, height: 1080 },
                { displayName: "Small desktop", width: 1280, height: 720 },
                { displayName: "Phone", width: 360, height: 800 },
                { displayName: "Custom" }
            ]
        }
        // Defaulting to a Phone view
        if(!this.previewSize) { this.previewSize = this.availablePreviewSizes[3]; }
    }

    static get styles() {
        return [unsafeCSS(gridcss), unsafeCSS(extracss), editorStyling, style];
    }

    /* ------------------------------ */

    // Checking whether actual changes have been made; if not, prevent updating.
    shouldUpdate(changedProperties: Map<PropertyKey, unknown>): boolean {
        const changed = changedProperties;
        if(changedProperties.has('latestChanges')
            && this.latestChanges?.changedKeys.length == 0
            && (JSON.stringify((changedProperties.get('latestChanges') as any)?.oldValue)) == (JSON.stringify((changedProperties.get('latestChanges') as any)?.newValue))) {
                changed.delete('latestChanges');
        }
        // Delete ones that not actually change anything
        changed.delete('latestDragWidgetStart');

        return (changed.size == 0 ? false : super.shouldUpdate(changedProperties));
    }


    // Main method for executing actions after property changes
    updated(changedProperties: Map<string, any>) {
        if(this.realm == undefined) { this.realm = manager.displayRealm; }

        // Setup template (list of widgets and properties)
        if(!this.template && this.dashboardId) {
            manager.rest.api.DashboardResource.get(this.dashboardId)
                .then((response) => { this.template = response.data.template!; })
                .catch((reason) => { console.error(reason); showSnackbar(undefined, i18next.t('errorOccurred')); });
        } else if(this.template == null && this.dashboardId == null) {
            console.warn("Neither the template nor dashboardId attributes have been specified!");
        }

        // If changes to the template have been made
        if(changedProperties.has("latestChanges")) {
            if(this.latestChanges) {
                this.processTemplateChanges(this.latestChanges);
                this.latestChanges = undefined;
            }
        }

        if(changedProperties.has("selectedWidget")) {
            if(this.selectedWidget) {
                if(changedProperties.get("selectedWidget") != undefined) { // if previous selected state was a different widget, dispatch event as well
                    this.dispatchEvent(new CustomEvent("deselected", { detail: changedProperties.get("selectedWidget") as DashboardWidget }));
                }
                if(this.grid?.el != null) {
                    const foundItem = this.grid?.getGridItems().find((item) => item.gridstackNode?.id == this.selectedWidget?.gridItem?.id);
                    if(foundItem != null) { this.selectGridItem(foundItem); }
                    this.dispatchEvent(new CustomEvent("selected", { detail: this.selectedWidget }));
                }

            } else {
                // Checking whether the mainGrid is not destroyed and there are Items to deselect...
                if(this.grid?.el != undefined && this.grid?.getGridItems() != null) {
                    this.deselectGridItems(this.grid.getGridItems());
                }
                this.dispatchEvent(new CustomEvent("deselected", { detail: changedProperties.get("selectedWidget") as DashboardWidget }));
            }
        }

        // Switching edit/view mode needs recreation of Grid
        if(changedProperties.has("editMode")) {
            if(changedProperties.get('editMode') != undefined) {
                this.setupGrid(true, true);
            }
        }

        // Adjusting previewSize when manual pixels control changes
        if(changedProperties.has("previewWidth") || changedProperties.has("previewHeight")) {
            if(this.template?.screenPresets) {
                this.previewSize = this.availablePreviewSizes?.find(s => ((s.width + "px" == this.previewWidth) && (s.height + "px" == this.previewHeight)));
            }
        }

        // Adjusting pixels control when previewSize changes.
        if(changedProperties.has('previewSize')) {
            if(this.previewSize) {
                this.previewWidth = this.previewSize.width + "px";
                this.previewHeight = this.previewSize.height + "px";
            }
        }

        if(changedProperties.has("rerenderPending")) {
            if(this.rerenderPending) {
                this.setupGrid(true, true).then(() => {
                    this.rerenderPending = false;
                    this.dispatchEvent(new CustomEvent("rerenderfinished"));
                });
            }
        }

        // When parent component requests a forced rerender
        if(changedProperties.has("rerenderActive")) {
            if(this.rerenderActive) {
                this.rerenderActive = false;
            }
        }
    }


    /* ---------------------------------------- */

    // Main setup Grid method (often used)
    async setupGrid(recreate: boolean, force: boolean = false) {
        await this.waitUntil((_: any) => this.shadowRoot?.getElementById("gridElement") != null)
        let gridElement = this.shadowRoot?.getElementById("gridElement");
        if(gridElement != null) {
            if(recreate && this.grid != null) {
                this.grid.destroy(false);

                if(force) { // Fully rerender the grid by switching rerenderPending on and off, and continue after that.
                    this.rerenderActive = true;
                    await this.updateComplete;
                    await this.waitUntil((_: any) => !this.rerenderActive);
                    gridElement = this.shadowRoot?.getElementById("gridElement");
                    this.grid = undefined;
                }
            }
            const width: number = (this.fullscreen ? this.clientWidth : (+(this.previewWidth?.replace(/\D/g, "")!)));
            const newPreset = getActivePreset(width, this.template.screenPresets!);
            if(newPreset?.scalingPreset != this.activePreset?.scalingPreset) {
                if(!(recreate && force)) { // Fully rerender the grid by switching rerenderPending on and off, and continue after that.
                    if(!recreate) { // If not destroyed yet, destroy first.
                        this.grid?.destroy(false);
                    }
                    this.rerenderActive = true;
                    await this.updateComplete;
                    await this.waitUntil((_: any) => !this.rerenderActive);
                    gridElement = this.shadowRoot?.getElementById("gridElement");
                    this.grid = undefined;
                }
            }
            this.activePreset = newPreset;


            // If grid got reset, setup the ResizeObserver again.
            if(this.grid == null) {
                const gridHTML = this.shadowRoot?.querySelector(".maingrid");
                this.setupResizeObserver(gridHTML!);
            }

            gridElement!.style.maxWidth = this.template.maxScreenWidth + "px";

            this.grid = GridStack.init({
                acceptWidgets: (this.editMode),
                animate: true,
                cellHeight: (this.activePreset?.scalingPreset == DashboardScalingPreset.WRAP_TO_SINGLE_COLUMN ? (width / (this.template?.columns ? (this.template.columns / 4) : 2)) : 'initial'),
                column: this.template?.columns,
                disableOneColumnMode: (this.activePreset?.scalingPreset != DashboardScalingPreset.WRAP_TO_SINGLE_COLUMN),
                oneColumnModeDomSort: true,
                draggable: {
                    appendTo: 'parent', // Required to work, seems to be Shadow DOM related.
                },
                float: true,
                margin: 5,
                resizable: {
                    handles: 'all'
                },
                staticGrid: (this.activePreset?.scalingPreset == DashboardScalingPreset.WRAP_TO_SINGLE_COLUMN ? true : (!this.editMode)),
                styleInHead: false
            }, gridElement!);

            gridElement!.style.backgroundSize = "" + this.grid.cellWidth() + "px " + this.grid.getCellHeight() + "px";
            gridElement!.style.height = "100%";
            gridElement!.style.minHeight = "100%";

            this.grid.on('dropped', (_event: Event, _previousWidget: any, newWidget: GridStackNode | undefined) => {
                if(this.grid != null && newWidget != null) {
                    this.grid.removeWidget((newWidget.el) as GridStackElement, true, false); // Removes dragged widget first
                    this.dispatchEvent(new CustomEvent("dropped", { detail: newWidget }));
                }
            });
            this.grid.on('change', (_event: Event, items: any) => {
                if(this.template != null && this.template.widgets != null) {
                    (items as GridStackNode[]).forEach(node => {
                        const foundWidget: DashboardWidget | undefined = this.template?.widgets?.find(widget => { return widget.gridItem?.id == node.id; });
                        foundWidget!.gridItem!.x = node.x;
                        foundWidget!.gridItem!.y = node.y;
                        foundWidget!.gridItem!.w = node.w;
                        foundWidget!.gridItem!.h = node.h;
                    });
                    this.dispatchEvent(new CustomEvent("changed", {detail: { template: this.template }}));
                }
            });
            this.grid.on('resizestart', (_event: Event) => {
                this.latestDragWidgetStart = new Date();
            });
            this.grid.on('resizestop', (_event: Event) => {
                setTimeout(() => {  this.latestDragWidgetStart = undefined; }, 200);
            });
        }
    }


    /* ------------------------------- */

    selectGridItem(gridItem: GridItemHTMLElement) {
        if(this.grid != null) {
            this.deselectGridItems(this.grid.getGridItems()); // deselecting all other items
            gridItem.querySelectorAll<HTMLElement>(".grid-stack-item-content").forEach((item: HTMLElement) => {
                item.classList.add('grid-stack-item-content__active'); // Apply active CSS class
            });
        }
    }
    deselectGridItem(gridItem: GridItemHTMLElement) {
        gridItem.querySelectorAll<HTMLElement>(".grid-stack-item-content").forEach((item: HTMLElement) => {
            item.classList.remove('grid-stack-item-content__active'); // Remove active CSS class
        });
    }

    deselectGridItems(gridItems: GridItemHTMLElement[]) {
        gridItems.forEach(item => {
            this.deselectGridItem(item);
        })
    }

    onGridItemClick(gridItem: DashboardGridItem | undefined) {
        if(!this.latestDragWidgetStart && !this.grid?.opts.staticGrid) {
            if(!gridItem) {
                this.selectedWidget = undefined;
            } else if(this.selectedWidget?.gridItem?.id != gridItem.id) {
                this.selectedWidget = this.template?.widgets?.find(widget => { return widget.gridItem?.id == gridItem.id; });
            }
        }
    }

    onFitToScreenClick() {
        const container = this.shadowRoot?.querySelector('#container');
        if(container) {
            const zoomWidth = +((0.95 * container.clientWidth) / +this.previewWidth!.replace('px', '')).toFixed(2);
            this.previewZoom = (zoomWidth > 1 ? 1 : zoomWidth);
        }
    }

    // Render
    protected render() {

        try { // to correct the list of gridItems each render (Hopefully temporarily since it's quite compute heavy)
            if(this.grid?.el && this.grid?.getGridItems()) {
                this.grid?.getGridItems().forEach((gridItem: GridItemHTMLElement) => {
                    if(this.template?.widgets?.find((widget) => widget.id == gridItem.id) == undefined) {
                        this.grid?.removeWidget(gridItem);
                    }
                })
            }
        } catch (e) { console.error(e); }

        const customPreset = "Custom";
        let screenPresets = this.template?.screenPresets?.map(s => s.displayName);
        screenPresets?.push(customPreset);
        return html`
            <div id="buildingArea" style="display: flex; flex-direction: column; height: 100%;" @click="${(event: PointerEvent) => { if((event.composedPath()[1] as HTMLElement).id === 'buildingArea') { this.onGridItemClick(undefined); }}}">
                ${this.editMode && !this.fullscreen ? html`
                    <div id="view-options">
                        <or-mwc-input id="fit-btn" type="${InputType.BUTTON}" icon="fit-to-screen"
                                      @or-mwc-input-changed="${() => this.onFitToScreenClick()}">
                        </or-mwc-input>
                        <or-mwc-input id="zoom-input" type="${InputType.NUMBER}" outlined label="${i18next.t('dashboard.zoomPercent')}" min="25" .value="${(this.previewZoom * 100)}" style="width: 90px"
                                      @or-mwc-input-changed="${debounce((event: OrInputChangedEvent) => { this.previewZoom = event.detail.value / 100; }, 50)}"
                        ></or-mwc-input>
                        <or-mwc-input id="view-preset-select" type="${InputType.SELECT}" outlined label="${i18next.t('dashboard.presetSize')}" style="min-width: 220px;"
                                      .value="${this.previewSize == undefined ? customPreset : this.previewSize.displayName}" .options="${this.availablePreviewSizes?.map((x) => x.displayName)}"
                                      @or-mwc-input-changed="${(event: OrInputChangedEvent) => { this.previewSize = this.availablePreviewSizes?.find(s => s.displayName == event.detail.value); }}"
                        ></or-mwc-input>
                        <or-mwc-input id="width-input" type="${InputType.NUMBER}" outlined label="${i18next.t('width')}" min="100" .value="${this.previewWidth?.replace('px', '')}" style="width: 90px"
                                      @or-mwc-input-changed="${debounce((event: OrInputChangedEvent) => { this.previewWidth = event.detail.value + 'px'; }, 550)}"
                        ></or-mwc-input>
                        <or-mwc-input id="height-input" type="${InputType.NUMBER}" outlined label="${i18next.t('height')}" min="100" .value="${this.previewHeight?.replace('px', '')}" style="width: 90px;"
                                      @or-mwc-input-changed="${(event: OrInputChangedEvent) => { this.previewHeight = event.detail.value + 'px'; }}"
                        ></or-mwc-input>
                        <or-mwc-input id="rotate-btn" type="${InputType.BUTTON}" icon="screen-rotation"
                                      @or-mwc-input-changed="${() => { const newWidth = this.previewHeight; const newHeight = this.previewWidth; this.previewWidth = newWidth; this.previewHeight = newHeight; }}">
                        </or-mwc-input>
                    </div>
                ` : undefined}
                ${this.rerenderActive ? html`
                    <div id="container" style="justify-content: center; align-items: center;">
                        <span>${i18next.t('dashboard.renderingGrid')}</span>
                    </div>
                ` : html`
                    <div id="container" style="justify-content: center; overflow: ${this.fullscreen ? undefined : 'hidden auto'}; position: relative;">
                        ${this.activePreset?.scalingPreset == DashboardScalingPreset.BLOCK_DEVICE ? html`
                            <div style="position: absolute; z-index: 3; height: 100%; display: flex; align-items: center;">
                                <span>${i18next.t('dashboard.deviceNotSupported')}</span>
                            </div>
                        ` : undefined}
                        <div class="${this.fullscreen ? 'maingridContainer__fullscreen' : 'maingridContainer'}">
                            <div class="maingrid ${this.fullscreen ? 'maingrid__fullscreen' : undefined }" 
                                 @click="${(ev: MouseEvent) => { if((ev.composedPath()[0] as HTMLElement).id == 'gridElement') { this.onGridItemClick(undefined) }}}" 
                                 style="width: ${this.previewWidth}; height: ${this.previewHeight}; visibility: ${this.activePreset?.scalingPreset == DashboardScalingPreset.BLOCK_DEVICE ? 'hidden' : 'visible'}; zoom: ${this.editMode && !this.fullscreen ? this.previewZoom : 'normal'}; ${this.editMode && !this.fullscreen ? ('-moz-transform: scale(' + this.previewZoom + ')') : undefined}; transform-origin: top;"
                            >
                                <!-- Gridstack element on which the Grid will be rendered -->
                                <div id="gridElement" class="grid-stack ${this.editMode ? 'grid-element' : undefined}" style="margin: auto;">
                                    ${this.template?.widgets ? repeat(this.template.widgets, (item) => item.id, (widget) => {
                                        return html`
                                            <div class="grid-stack-item" id="${widget.id}" gs-id="${widget.gridItem?.id}" gs-x="${widget.gridItem?.x}" gs-y="${widget.gridItem?.y}" gs-w="${widget.gridItem?.w}" gs-h="${widget.gridItem?.h}" @click="${() => { this.onGridItemClick(widget.gridItem); }}">
                                                <div class="grid-stack-item-content" style="display: flex;">
                                                    <or-dashboard-widget .widget="${widget}" .editMode="${this.editMode}" .realm="${this.realm}" style="width: 100%; height: auto;"></or-dashboard-widget>
                                                </div>
                                            </div>
                                        `
                                    }) : undefined}
                                </div>
                            </div>
                        </div>
                    </div>
                `}
            </div>
            <style>
                ${cache(when(this.isExtraLargeGrid(),
                        () => this.applyCustomGridstackGridCSS(this.getGridstackColumns(this.grid) ? this.getGridstackColumns(this.grid)! : this.template.columns!)
                ))}
            </style>
        `
    }

    getGridstackColumns(grid: GridStack | undefined): number | undefined {
        try { return grid?.getColumn(); }
        catch (e) { return undefined; }
    }

    isExtraLargeGrid(): boolean {
        return !!this.grid && (
            (this.getGridstackColumns(this.grid) && this.getGridstackColumns(this.grid)! > 12)
            || !!(this.template?.columns && this.template.columns > 12)
        );
    }



    private cachedGridstackCSS: Map<number, TemplateResult[]> = new Map<number, TemplateResult[]>();

    // Provides support for > 12 columns in GridStack (which requires manual css edits)
    //language=html
    applyCustomGridstackGridCSS(columns: number): TemplateResult {
        if(this.cachedGridstackCSS.has(columns)) {
            return html`${this.cachedGridstackCSS.get(columns)!.map((x) => x)}`;
        } else {
            const htmls: TemplateResult[] = [];
            for(let i = 0; i < (columns + 1); i++) {
                htmls.push(html`
                    <style>
                        .grid-stack > .grid-stack-item[gs-w="${i}"]:not(.ui-draggable-dragging):not(.ui-resizable-resizing) { width: ${100 - (columns - i) * (100 / columns)}% !important; }
                        .grid-stack > .grid-stack-item[gs-x="${i}"]:not(.ui-draggable-dragging):not(.ui-resizable-resizing) { left: ${100 - (columns - i) * (100 / columns)}% !important; }                    
                    </style>
                `);
            }
            this.cachedGridstackCSS.set(columns, htmls);
            return html`${htmls.map((x) => x)}`;
        }
    }



    /* ---------------------------------------------- */


    @state()
    protected resizeObserver?: ResizeObserver;

    protected previousObserverEntry?: ResizeObserverEntry;

    disconnectedCallback() {
        super.disconnectedCallback()
        this.resizeObserver?.disconnect();
    }

    // Triggering a Grid rerender on every time the element resizes.
    // In fullscreen, debounce (only trigger after 550ms of no changes) to limit amount of rerenders.
    setupResizeObserver(element: Element): ResizeObserver {
        this.resizeObserver?.disconnect();
        if(this.fullscreen) {
            this.resizeObserver = new ResizeObserver(debounce(this.resizeObserverCallback, 200));
        } else {
            this.resizeObserver = new ResizeObserver(this.resizeObserverCallback);
        }
        this.resizeObserver.observe(element);
        return this.resizeObserver;
    }

    protected resizeObserverCallback: ResizeObserverCallback = (entries: ResizeObserverEntry[]) => {
        if((this.previousObserverEntry?.contentRect.width + "px") !== (entries[0].contentRect.width + "px")) {
            this._onGridResize();
        }
        this.previousObserverEntry = entries[0];
    }

    _onGridResize() {
        this.setupGrid(true, false);
    }

    /* --------------------------------------- */

    processTemplateChanges(changes: { changedKeys: string[], oldValue: DashboardTemplate, newValue: DashboardTemplate }) {

        // If only columns property changed, change columns through the framework and then recreate grid.
        if(changes.changedKeys.length == 1 && changes.changedKeys.includes('columns') && this.grid) {
            this.grid.column(changes.newValue.columns!);
            let maingrid = this.shadowRoot?.querySelector(".maingrid");
            let gridElement = this.shadowRoot?.getElementById("gridElement");
            gridElement!.style.backgroundSize = "" + this.grid.cellWidth() + "px " + this.grid.getCellHeight() + "px";
            gridElement!.style.height = maingrid!.scrollHeight + 'px';
            this.setupGrid(true, false);
        }

        // If multiple properties changed, just force rerender all of it.
        else if(changes.changedKeys.length > 1) {
            this.setupGrid(true, true);
        }

        // On widgets change, check whether they are programmatically added to GridStack. If not, adding them.
        else if(changes.changedKeys.includes('widgets')) {
            if(this.grid?.el != null) {
                this.grid.getGridItems().forEach((gridElement) => {
                    if(!gridElement.classList.contains('ui-draggable')) {
                        this.grid?.makeWidget(gridElement);
                    }
                })
            }
        }
        else if(changes.changedKeys.includes('screenPresets')) {
            this.setupGrid(true, true);
        }
    }

    // Wait until function that waits until a boolean returns differently
    waitUntil(conditionFunction: any) {
        const poll = (resolve: any) => {
            if(conditionFunction()) resolve();
            else setTimeout(_ => poll(resolve), 400);
        }
        return new Promise(poll);
    }
}
