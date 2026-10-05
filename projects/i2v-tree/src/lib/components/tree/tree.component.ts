import {
    Component,
    TemplateRef,
    Input,
    Output,
    EventEmitter,
    ContentChild,
    ViewChild,
    ChangeDetectionStrategy,
    AfterContentInit,
    AfterViewInit,
    OnDestroy,
    ChangeDetectorRef,
    HostListener,
    HostBinding,
    ElementRef,
    inject
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { I2vTree } from './tree.model';
import {i2vUtilityModule} from '@i2v-systems/i2v-utility';
import {
    AsyncTreeChildAccessor,
    DefaultIcons,
    DragArgs,
    DragPos,
    I2vTreeConfig,
    ResolvedTreeConfig,
    TREE_ITEM_MIME,
    I2vItemState
} from './tree.config';
import { SetAttrsDirective } from '../set-attrs.directive';
import { I2vTreeRowDirective, I2vTreeRowPrefixDirective, I2vTreeRowSuffixDirective } from './tree.templates';
import { I2vTreeEditor, I2vTreeSearch, Node, VirtualRenderArea } from '../../models';

/** How long to hover over a collapsed node during a drag before it opens */
const DRAG_EXPAND_DELAY = 600;

/** How long a type-ahead buffer survives between keystrokes */
const TYPEAHEAD_RESET = 1000;

@Component({
    selector: 'i2v-tree',
    standalone: true,
    imports: [NgTemplateOutlet, SetAttrsDirective, i2vUtilityModule],
    templateUrl: './tree.component.html',
    styleUrl: './tree.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class I2vTreeComponent implements AfterContentInit, AfterViewInit, OnDestroy {
    private readonly cdr = inject(ChangeDetectorRef);
    private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

    private disposers: (() => void)[] = [];
    private renderArea = new VirtualRenderArea();
    private destroyed = false;
    private viewInitialized = false;
    private initTimeout?: any;
    private resizeObserver?: ResizeObserver;

    private _model: I2vTree<any>;
    private _config: ResolvedTreeConfig<any>;
    private childAccessor: AsyncTreeChildAccessor<any> = (item: any) => item.children;

    /**
     * Stable indirection handed to the model. It always dispatches to the *current* childAccessor,
     * so [config] and [data] can be bound in either order.
     */
    private readonly childAccessorWrapper = (item: any) => this.getChildren(item);

    private loadingItems = new Set<any>();
    private stateProvider: I2vItemState<any> = Object.seal({
        isExpanded: (item: any) => this.model.isExpanded(item),
        isSelected: (item: any) => this.model.isSelected(item),
        isHighlighted: (item: any) => this.model.isHighlighted(item),
        isLoading: (item: any) => this.isItemLoading(item)
    });

    private _filterText: string | undefined = '';
    private _highlightTerm: string | undefined;
    private filterTextThrottle?: any;

    private ownId = Math.random().toString();
    private ownDragItem?: Node<any>;
    private dragExpand: { item?: Node<any>; timeout?: any } = {};

    private typeaheadBuffer = '';
    private typeaheadTimeout?: any;

    /** Prefix for row DOM ids, unique per component instance so two trees cannot collide. */
    private readonly instanceId = `i2v-tree-${(I2vTreeComponent.instanceCounter = I2vTreeComponent.instanceCounter + 1)}`;
    private static instanceCounter = 0;

    /**
     * @ignore
     */
    @HostBinding('tabIndex')
    public tabIndex = 0;

    /**
     * Marks the container as a tree for assistive technology. Rows carry `role="treeitem"`.
     * @ignore
     */
    @HostBinding('attr.role')
    public readonly role = 'tree';

    /**
     * @ignore
     */
    @HostBinding('attr.aria-multiselectable')
    public get ariaMultiselectable() {
        return this.config.selectionMode === 'multiple' ? 'true' : null;
    }

    /**
     * Points at the highlighted row so a screen reader follows the keyboard cursor without the tree
     * having to move real DOM focus between recycled rows.
     * @ignore
     */
    @HostBinding('attr.aria-activedescendant')
    public get ariaActiveDescendant() {
        const item = this.model.getHighlightedItem();
        return item === undefined ? null : this.getRowId(item);
    }

    /**
     * Accessible name for the tree as a whole.
     */
    @Input()
    @HostBinding('attr.aria-label')
    public ariaLabel: string | null = null;

    /**
     * Stable per-row DOM id, needed by `aria-activedescendant`. Derived from the item's key when one
     * is configured, so it survives row recycling; otherwise from the row's position.
     * @ignore
     */
    public getRowId(item: any) {
        const keyOf = this.config.keyOf,
            key = keyOf ? keyOf(item) : this.model.getItemIndex(item);
        // Keys can be anything, including strings with spaces, so anything not id-safe is replaced.
        return `${this.instanceId}-row-${String(key).replace(/[^\w-]/g, '_')}`;
    }

    /**
     * @ignore
     */
    public visibleItems: Node<any>[] = [];

    /**
     * @ignore
     */
    public isDraggingOver = false;

    /**
     * The consumer's row template. When absent the tree renders its built-in row.
     * @ignore
     */
    @ContentChild(TemplateRef)
    public bareTemplate?: TemplateRef<any>;

    /**
     * The row template when declared with the `i2vTreeRow` directive, which is the typed form.
     * @ignore
     */
    @ContentChild(I2vTreeRowDirective)
    public rowDirective?: I2vTreeRowDirective;

    /** @ignore */
    @ContentChild(I2vTreeRowPrefixDirective)
    public rowPrefix?: I2vTreeRowPrefixDirective;

    /** @ignore */
    @ContentChild(I2vTreeRowSuffixDirective)
    public rowSuffix?: I2vTreeRowSuffixDirective;

    /**
     * The row template in force. The directive form wins; the bare `<ng-template>` is still honoured
     * so templates written before the directive existed keep working.
     *
     * A prefix or suffix template is not a row template, and `@ContentChild(TemplateRef)` would
     * otherwise match whichever came first in the markup and render it as the whole row.
     * @ignore
     */
    /**
     * Row template supplied as an input rather than projected.
     *
     * Preferred when a wrapper component holds the template, because anything placed inside
     * `<i2v-tree>` to select between templates -- an `@if`, an `*ngIf` -- compiles to an
     * `<ng-template>` that the untagged content query cannot distinguish from a row template.
     */
    @Input()
    public rowTemplate?: TemplateRef<any>;

    /** Prefix slot supplied as an input. See {@link rowTemplate}. */
    @Input()
    public rowPrefixTemplate?: TemplateRef<any>;

    /** Suffix slot supplied as an input. See {@link rowTemplate}. */
    @Input()
    public rowSuffixTemplate?: TemplateRef<any>;

    public get template(): TemplateRef<any> | undefined {
        if (this.rowTemplate) {
            return this.rowTemplate;
        }
        if (this.rowDirective) {
            return this.rowDirective.template;
        }
        // Once any slot is in play the consumer is on the explicit API, so the untagged query is
        // ignored entirely. It cannot tell a row template apart from a slot -- or from the template
        // a control-flow block compiles to -- and guessing wrong renders that as the row.
        if (this.rowPrefix || this.rowSuffix || this.rowPrefixTemplate || this.rowSuffixTemplate) {
            return undefined;
        }

        return this.bareTemplate;
    }

    /** @ignore Resolved prefix slot, from the input or the projected directive. */
    public get prefixTemplate(): TemplateRef<any> | undefined {
        return this.rowPrefixTemplate ?? this.rowPrefix?.template;
    }

    /** @ignore Resolved suffix slot, from the input or the projected directive. */
    public get suffixTemplate(): TemplateRef<any> | undefined {
        return this.rowSuffixTemplate ?? this.rowSuffix?.template;
    }

    /**
     * @ignore
     */
    @ViewChild('dragOverlay', { static: true })
    public dragOverlay?: ElementRef<HTMLDivElement>;

    /**
     * Fires on change of the selected item, [selection]
     */
    @Output()
    public selectionChange = new EventEmitter<any>();

    /**
     * ContextMenu event on tree rows, allows custom right-click menus
     */
    @Output()
    public itemContextMenu = new EventEmitter<{ event: MouseEvent; item: any }>();

    /**
     * Click event that fires on click of the icon portion of a tree row
     */
    @Output()
    public iconClick = new EventEmitter<{ event: MouseEvent; item: any }>();

    /**
     * Click event that fires on click of the label portion of a tree row
     */
    @Output()
    public labelClick = new EventEmitter<{ event: MouseEvent; item: any }>();

    /**
     * Click event that fires on click of any part of a tree row
     */
    @Output()
    public rowClick = new EventEmitter<{ event: MouseEvent; item: any }>();

    /**
     * Double click on a tree row
     */
    @Output()
    public itemDblClick = new EventEmitter<{ event: MouseEvent; item: any }>();

    /**
     * Enter pressed on the highlighted row. Separate from selection, because activating a row
     * ("open this") is a different intent from selecting it.
     */
    @Output()
    public itemActivate = new EventEmitter<{ event: KeyboardEvent; item: any }>();

    /**
     * Escape pressed within the tree. Lets a host close a popup without the tree knowing about it.
     */
    @Output()
    public escape = new EventEmitter<KeyboardEvent>();

    /**
     * The keyboard cursor moved to a different row
     */
    @Output()
    public activeItemChange = new EventEmitter<any>();

    /**
     * A row's check state changed
     */
    @Output()
    public checkChange = new EventEmitter<{ item: any; checked: boolean }>();

    /**
     * A row was expanded or collapsed
     */
    @Output()
    public expandChange = new EventEmitter<{ item: any; expanded: boolean }>();

    /**
     * An instance of an I2vTree<T> configured to your dataset
     */
    @Input()
    public set model(value: I2vTree<any>) {
        this._model = value;
        this.listenToModel(value);
        // A model bound after it was loaded has already emitted onDataInvalidated, so read its
        // current rows now instead of showing the previous model's until something else changes.
        this.handleDataChange();
    }
    public get model() {
        return this._model;
    }

    /**
     * Height each item in the tree
     */
    @Input()
    public set itemHeight(value: number) {
        this.renderArea.itemHeight = value;
    }
    public get itemHeight() {
        return this.renderArea.itemHeight;
    }

    /**
     * The config for the tree
     */
    @Input()
    public set config(value: I2vTreeConfig<any>) {
        this.childAccessor = value.childAccessor || this.childAccessor;
        this._config = { ...this._config, ...value, childAccessor: this.childAccessorWrapper };
        this.model.updateConfig(this._config);
    }
    // Explicit return type: with no annotation a getter inherits its paired setter's parameter
    // type, which would hand every internal caller the all-optional I2vTreeConfig back.
    public get config(): ResolvedTreeConfig<any> {
        return this._config;
    }

    /**
     * Input for loading data into the tree
     */
    @Input()
    public set data(items: any[]) {
        this.model.load(items);
    }

    /**
     * Input for the selected item
     */
    @Input()
    public set selection(value: any) {
        if (!this.model.isSelected(value)) {
            this.model.select(value);
            this.navigateToSelection();
        }
    }

    /**
     * Allows applying an arbitrary filter to the tree. This overrides filterText
     */
    @Input()
    public set filter(value: ((item: any) => boolean) | undefined) {
        this.model.setFilter(value);
    }

    /**
     * Filter the tree with default text filter, case insenstive contains on item names
     */
    @Input()
    public set filterText(value: string | undefined) {
        this.handleFilterTextChange(value);
    }

    /**
     * Term to highlight in row labels, without filtering.
     *
     * Separate from {@link filterText}, which both filters and highlights. A wrapper that applies
     * its own filter -- a search box choosing which field to match -- needs the highlight without a
     * second, competing filter being scheduled behind it.
     */
    @Input()
    public set highlightTerm(value: string | undefined) {
        this._highlightTerm = value;
        this.cdr.markForCheck();
    }
    public get highlightTerm() {
        return this._highlightTerm;
    }

    /**
     * returns true if filterText or a filter function is applied
     */
    public get isFiltered() {
        return this.model.isFiltered();
    }

    /**
     * Index of the first rendered row within the whole flattened tree.
     * @ignore
     */
    public get visibleStart() {
        return this.renderArea.visibleStart;
    }

    /**
     * Row state accessors, exposed to templates so a custom row can read expanded/selected/loading
     * without reaching into the model.
     * @ignore
     */
    public get itemState(): I2vItemState<any> {
        return this.stateProvider;
    }

    /**
     * Build the context handed to the prefix and suffix slot templates. Matches the row context, so
     * one template can be moved between the three positions unchanged.
     * @ignore
     */
    public rowContext(node: Node<any>, index: number, absoluteIndex: number) {
        const count = this.model.items.length;
        return {
            $implicit: node,
            index,
            absoluteIndex,
            count,
            first: absoluteIndex === 0,
            last: absoluteIndex === count - 1,
            even: absoluteIndex % 2 === 0,
            odd: absoluteIndex % 2 === 1,
            state: this.stateProvider
        };
    }

    /**
     * @ignore
     */
    public get topBuffer() {
        return this.renderArea.topBuffer;
    }

    /**
     * @ignore
     */
    public get totalHeight() {
        return this.renderArea.totalHeight;
    }

    constructor() {
        this._config = {
            childAccessor: this.childAccessorWrapper,
            getIcon: (item: any) =>
                item.type !== 'd' && item.type !== 'Folder'
                    ? item.icon || this.config.itemIcon
                    : this.model.isExpanded(item)
                    ? DefaultIcons.folderOpen
                    : DefaultIcons.folder,
            getName: (item: any) => item.name,
            getDomNodeAttr: () => undefined,
            itemIcon: DefaultIcons.file,
            filterThrottle: 500,
            filterTextMinLength: 2,
            lazyLoad: true,
            canDrag: () => false,
            canDrop: () => false,
            // Actually performs the move against the consumer's own arrays. A no-op default would
            // mean drag and drop appears to work and silently changes nothing.
            move: args => this.defaultMove(args),
            getDragData: () => '{}',
            selectionMode: 'single',
            expandMode: 'multi',
            checkboxes: false,
            highlightMatches: true,
            allowedDropPositions: ['before', 'on', 'after']
        };
        this._model = new I2vTree<any>(this._config);
        this.listenToModel(this._model);
        // Without a height the render area divides by zero and every row is "visible".
        this.renderArea.itemHeight = 1.5 * parseFloat(window.getComputedStyle(document.body).fontSize || '16');
    }

    /**
     * @ignore
     */
    public ngAfterContentInit() {
        // Set imperatively rather than via @HostBinding: `template` only resolves at content init,
        // and a host binding read in the same pass trips ExpressionChangedAfterItHasBeenChecked.
        if (!this.template) {
            this.element.nativeElement.classList.add('i2v-default-rows');
        }
    }

    /**
     * @ignore
     */
    public ngAfterViewInit() {
        this.viewInitialized = true;
        this.handleDataChange();
        this.invalidateSize();
        this.syncScrollPos();
        // The tree can be placed inside flex/grid/layout containers whose size settles after
        // Angular's first render. Observe the actual tree host instead of relying on window resize.
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => {
                if (!this.destroyed) {
                    this.invalidateSize();
                }
            });
            this.resizeObserver.observe(this.element.nativeElement);
        }

        // One deferred pass covers browsers where the first ResizeObserver notification is delayed.
        this.initTimeout = setTimeout(() => this.invalidateSize(), 0);
    }

    /**
     * @ignore
     */
    public ngOnDestroy() {
        this.destroyed = true;
        this.dispose();
        clearTimeout(this.initTimeout);
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        clearTimeout(this.filterTextThrottle);
        clearTimeout(this.dragExpand.timeout);
    }

    /**
     * @ignore
     */
    @HostListener('keydown', ['$event'])
    public handleKeydown(evt: KeyboardEvent) {
        const highlighted = this.model.getHighlightedItem();

        if (evt.key === 'Enter') {
            this.model.selectHighlightedItem();
            if (highlighted !== undefined) {
                this.itemActivate.emit({ event: evt, item: highlighted });
            }
            evt.preventDefault();
            return;
        }

        if (evt.key === ' ' || evt.key === 'Spacebar') {
            // Space toggles the check when checkboxes are on, matching the platform convention for
            // a multi-select list; otherwise it falls back to expanding, as zTree did.
            if (highlighted !== undefined) {
                if (this.config.checkboxes) {
                    this.toggleCheck(highlighted);
                } else {
                    this.model.toggle(highlighted);
                }
            }
            // Always prevented: space would otherwise scroll the container out from under the user.
            evt.preventDefault();
            return;
        }

        if (evt.key === 'Escape') {
            this.escape.emit(evt);
            return;
        }

        if (evt.key === 'ContextMenu' || (evt.key === 'F10' && evt.shiftKey)) {
            if (highlighted !== undefined) {
                this.itemContextMenu.emit({ event: evt as unknown as MouseEvent, item: highlighted });
                evt.preventDefault();
            }
            return;
        }

        if (evt.key === 'Home' || evt.key === 'End' || evt.key.startsWith('Arrow')) {
            const direction = evt.key.startsWith('Arrow') ? evt.key.replace('Arrow', '') : evt.key,
                nextHighlightedIndex = this.model.navigate(direction);

            if (nextHighlightedIndex !== undefined) {
                this.scrollToIndex(nextHighlightedIndex);
                this.activeItemChange.emit(this.model.getHighlightedItem());
            }
            evt.preventDefault();
            return;
        }

        this.handleTypeahead(evt);
    }

    /**
     * Jump to a row by typing its first letters.
     *
     * Only single printable characters with no modifier qualify, so shortcuts such as ctrl+A are
     * left to the host. The buffer resets after a pause, which is what makes repeatedly pressing one
     * letter cycle through matches instead of searching for a run of that letter.
     */
    private handleTypeahead(evt: KeyboardEvent) {
        const printable = evt.key.length === 1 && !evt.ctrlKey && !evt.metaKey && !evt.altKey;
        if (!printable) {
            return;
        }

        clearTimeout(this.typeaheadTimeout);
        this.typeaheadBuffer += evt.key;
        this.typeaheadTimeout = setTimeout(() => (this.typeaheadBuffer = ''), TYPEAHEAD_RESET);

        const at = this.model.typeahead(this.typeaheadBuffer, item => this.getName(item));
        if (at !== undefined) {
            this.scrollToIndex(at);
            this.activeItemChange.emit(this.model.getHighlightedItem());
            evt.preventDefault();
        }
    }

    /**
     * @ignore
     */
    @HostListener('scroll')
    public handleScrollChange() {
        if (this.element.nativeElement) {
            this.renderArea.scrollPos = this.element.nativeElement.scrollTop;
            this.updateVisibleItems();
        }
    }

    /**
     * @ignore
     */
    @HostListener('window:resize')
    public handleWindowResize() {
        this.invalidateSize();
    }

    /**
     * Fix issues occurring from tree container's height has changed
     */
    public invalidateSize() {
        if (this.element.nativeElement) {
            const bounds = this.element.nativeElement.getBoundingClientRect();
            this.renderArea.viewerHeight = bounds.height;
            this.updateVisibleItems();
            this.refresh();
        }
    }

    /**
     * Scroll the container until the selected item is in view. If the selected item is already in view, do nothing.
     */
    public scrollToSelected() {
        const selectedIndex = this.model.getSelectedIndex();
        if (typeof selectedIndex === 'number') {
            this.scrollToIndex(selectedIndex);
        }
    }

    /**
     * Scroll to a certain position
     * @param offset In pixels, the scroll position to jump to
     */
    public scrollTo(offset: number) {
        const { nativeElement } = this.element;
        if (nativeElement) {
            nativeElement.scrollTop = offset;
        }
    }

    /**
     * Scroll the container until the item is in view. If the item is already in view, do nothing.
     */
    public scrollToItem(item: any) {
        const selectedIndex = this.model.getItemIndex(item);
        if (typeof selectedIndex === 'number' && selectedIndex > -1) {
            this.scrollToIndex(selectedIndex);
        }
    }

    /**
     * Scroll the container until the item at the index is in view. If the item at the index is already in view, do nothing.
     */
    public scrollToIndex(index: number) {
        const { nativeElement } = this.element;
        if (nativeElement) {
            const { viewerHeight, itemHeight } = this.renderArea,
                itemTop = index * itemHeight,
                itemBottom = itemTop + itemHeight;

            if (itemTop < nativeElement.scrollTop) {
                nativeElement.scrollTop = itemTop;
            } else if (itemBottom > nativeElement.scrollTop + viewerHeight) {
                nativeElement.scrollTop = itemBottom - viewerHeight;
            }
        }
    }

    /**
     * Get the current scroll offset, pixels
     */
    public getScrollPos() {
        return this.renderArea.scrollPos;
    }

    /**
     * Adjust the DOM scroll position to match the VirtualRenderArea scroll postion, and vice versa.
     * This can fix some issues that occur after DOM height changes
     */
    public syncScrollPos() {
        const { nativeElement } = this.element;
        if (nativeElement) {
            if (nativeElement.scrollTop !== this.renderArea.scrollPos) {
                nativeElement.scrollTop = this.renderArea.scrollPos;
                this.renderArea.scrollPos = nativeElement.scrollTop;
            }
        }
    }

    /**
     * Scrolls and expands nodes so that the selected item is visible in the tree
     */
    public navigateToSelection() {
        this.model.expandToSelectedItem();
        return this.scrollToSelected();
    }

    /**
     * Scrolls and expands nodes so that the passed item is visible in the tree
     */
    public navigateToItem(item: any) {
        this.model.expandToItem(item);
        // expandToItem only mutates the expanded set. Without this the item is still absent from
        // the flattened rows and the scroll below silently no-ops.
        this.model.invalidateData();
        return this.scrollToItem(item);
    }

    /**
     * True while the passed item is waiting on its children to load
     */
    public isItemLoading(item: any) {
        return this.loadingItems.has(item);
    }

    /** @ignore */
    public handleContextMenu(evt: MouseEvent, item: any) {
        this.itemContextMenu.emit({ event: evt, item });
    }

    /** @ignore */
    public handleRowClick(evt: MouseEvent, item: any) {
    if (this.isDisabled(item)) {
        return;
    }

    // Existing selection + highlight/focus
    this.model.selectWithModifiers(item, {
        ctrl: evt.ctrlKey || evt.metaKey,
        shift: evt.shiftKey
    });

    // Expand/collapse when clicking anywhere on an expandable node
    if (this.model.isExpandable(item)) {
        this.model.toggle(item);

        this.expandChange.emit({
            item,
            expanded: this.model.isExpanded(item)
        });
    }

    this.rowClick.emit({ event: evt, item });
}

    /** @ignore */
    public handleRowDblClick(evt: MouseEvent, item: any) {
        this.itemDblClick.emit({ event: evt, item });
    }

    /**
     * Toggle a row's expand state, reporting the result. Public so a consumer template can drive the
     * built-in expander from its own markup.
     */
    public toggleExpand(item: any) {
        this.model.toggle(item);
        this.expandChange.emit({ item, expanded: this.model.isExpanded(item) });
    }

    /**
     * Toggle a row's check state. Public for the same reason as {@link toggleExpand}.
     */
    public toggleCheck(item: any) {
        if (!this.canCheck(item)) {
            return;
        }
        this.model.checks.toggle(item);
        this.checkChange.emit({ item, checked: this.model.checks.isChecked(item) });
    }

    /** @ignore */
    public handleCheckboxClick(evt: Event, item: any) {
        // The row underneath must not select on a checkbox click: picking an item and looking at it
        // are different intents, and a checkbox click means only the former.
        evt.stopPropagation();
        this.toggleCheck(item);
    }

    /** True if the item may carry a checkbox. zTree's per-node `nocheck`. */
    public canCheck(item: any) {
        return this.config.check?.canCheck ? this.config.check.canCheck(item) : true;
    }

    /** @ignore */
    public isChecked(item: any) {
        return this.model.checks.isChecked(item);
    }

    /** @ignore */
    public isIndeterminate(item: any) {
        return this.model.checks.getState(item) === 'indeterminate';
    }

    /** True if the item cannot be selected or activated. */
    public isDisabled(item: any) {
        return this.config.isDisabled ? this.config.isDisabled(item) : false;
    }

    /**
     * The label split into matched and unmatched segments for the active text filter.
     *
     * Returned as data rather than markup: the template renders each segment as its own element, so
     * highlighting never goes through innerHTML the way zTree's `nameIsHTML` did.
     */
    public getNameSegments(item: any) {
        const name = this.getName(item),
            term = this._highlightTerm ?? this._filterText;

        if (!this.config.highlightMatches || !term) {
            return [{ text: name, match: false }];
        }

        return I2vTreeSearch.getSegments(name, term);
    }

    /** @ignore Image-path icon, for data that carries icon URLs rather than CSS classes. */
    public getIconUrl(node: Node<any>) {
        return this.config.getIconUrl ? this.config.getIconUrl(node.item, node, this.stateProvider) : undefined;
    }

    /** @ignore */
    public getTitle(item: any) {
        return this.config.getTitle ? this.config.getTitle(item) : undefined;
    }

    /**
     * 1-based position of a row among its siblings, for `aria-posinset`.
     * @ignore
     */
    public getPosInSet(node: Node<any>) {
        return node.index + 1;
    }

    /**
     * Number of siblings a row has, for `aria-setsize`. Falls back to -1 ("unknown") when the parent
     * is not loaded, which is the correct ARIA answer rather than a guess.
     * @ignore
     */
    public getSetSize(node: Node<any>) {
        return node.parent && node.parent.childrenLoaded ? node.parent.children.length : -1;
    }

    /**
     * `aria-expanded` for a row, or undefined for leaves -- the attribute must be absent on a node
     * that cannot expand, not set to false.
     * @ignore
     */
    public getAriaExpanded(item: any): boolean | undefined {
        return this.model.isExpandable(item) ? this.model.isExpanded(item) : undefined;
    }

    /** @ignore */
    public getIcon(node: Node<any>) {
        return `i2v-icon ${this.config.getIcon(node.item, node, this.stateProvider)}`;
    }

    /** @ignore */
    public getDomNodeAttr(node: Node<any>) {
        return this.config.getDomNodeAttr(node.item, node, this.stateProvider);
    }

    /** @ignore */
    public getName(item: any) {
        return this.config.getName(item, this.stateProvider) || '';
    }

    /** @ignore */
    public getExpanderIcon(item: any): string {
    return this.model.isExpanded(item)
        ? 'assets/Outline/chevron-down.svg'
        : 'assets/Outline/chevron-right.svg';
}

    /**
     * True if the passed item may be dragged. Public so a consumer template can opt into the
     * built-in drag and drop.
     */
    public canDrag(item: any) {
        return this.config.canDrag(item);
    }

    /**
     * Begin a drag of the passed node. Public so a consumer template can opt into the built-in
     * drag and drop by wiring its own row's (dragstart).
     */
    public handleDragstart(evt: DragEvent, node: Node<any>) {
        this.ownDragItem = node;
        if (this.canDrag(node.item)) {
            if (evt.dataTransfer) {
                evt.dataTransfer.dropEffect = 'move';
                evt.dataTransfer.setData(TREE_ITEM_MIME, this.getDragData(node.item));
                evt.dataTransfer.setData(`text/plain.${this.ownId}`, '{}');
            }
        }
    }

    /** @ignore */
    @HostListener('dragover', ['$event'])
    public handleDragover(evt: DragEvent) {
        // Ignore drags that are not ours -- a file dragged in from the desktop should not light up
        // the overlay, and under OnPush every one of these costs a change detection pass.
        if (!evt.dataTransfer || !evt.dataTransfer.types.includes(TREE_ITEM_MIME)) {
            return;
        }
        this.isDraggingOver = true;
        const dropInfo = this.getDropInfo(evt, false);
        if (dropInfo.canDrop()) {
            this.adjustDragOverlay(dropInfo);
            evt.preventDefault();
        }
        if (dropInfo.draggedItem !== dropInfo.parent) {
            this.tryDragExpand(dropInfo);
        }
    }

    /** @ignore */
    @HostListener('dragleave', ['$event'])
    public handleDragleave(evt: DragEvent) {
        // dragleave bubbles from every row, so moving between rows would otherwise flicker the
        // overlay. Only a pointer that has actually left the tree counts.
        const movedTo = evt.relatedTarget as HTMLElement | null;
        if (movedTo && this.element.nativeElement.contains(movedTo)) {
            return;
        }
        this.isDraggingOver = false;
    }

    /** @ignore */
    @HostListener('dragend')
    public handleDragend() {
        this.ownDragItem = undefined;
        this.isDraggingOver = false;
    }

    /** @ignore */
    @HostListener('drop', ['$event'])
    public handleDrop(evt: DragEvent) {
        this.isDraggingOver = false;
        if (evt.dataTransfer && evt.dataTransfer.types.includes(TREE_ITEM_MIME)) {
            const dropInfo = this.getDropInfo(evt, true);
            if (dropInfo.canDrop()) {
                this.move(dropInfo.draggedItem, dropInfo.parent!, dropInfo.index);
            }
        }
    }

    private tryDragExpand(dropInfo: { parent?: Node<any>; area: DragPos }) {
        if (dropInfo.area !== 'on' || this.dragExpand.item !== dropInfo.parent) {
            clearTimeout(this.dragExpand.timeout);
        }
        if (this.dragExpand.item !== dropInfo.parent && dropInfo.parent && dropInfo.area === 'on') {
            this.dragExpand.item = dropInfo.parent;
            this.dragExpand.timeout = setTimeout(() => {
                this.model.setExpanded(dropInfo.parent!.item, true);
                this.model.invalidateData();
            }, DRAG_EXPAND_DELAY);
        }
    }

    /**
     * Built-in move: splices the item between the children arrays the tree was given.
     *
     * Only usable when the data is plain nested arrays reachable through `childAccessor`. Consumers
     * whose data lives elsewhere -- a store, a server -- override `config.move`.
     */
    private defaultMove(args: DragArgs<any>): Promise<void> {
        const editor = new I2vTreeEditor<any>(
            {
                childAccessor: item => this.childAccessor(item) as any[] | undefined,
                setChildren: (item, children) => (item.children = children)
            },
            () => this.model.query.getRootNode().children.map(n => n.item)
        );

        editor.move(args.item, args.parent, args.index, this.model.query);
        return Promise.resolve();
    }

    private async move(item: any, parent: Node<any>, index: number | undefined) {
        const itemNode = item instanceof Node ? item : undefined,
            itemData = itemNode ? itemNode.item : item,
            parentItem = parent ? parent.item : undefined,
            fromParent = itemNode && itemNode.parent ? itemNode.parent.item : undefined;

        await this.config.move({
            itemNode,
            parentNode: parent,
            item: itemData,
            parent: parentItem,
            index
        });

        if (this.destroyed) {
            return;
        }
        this.model.invalidateItem(fromParent);
        this.model.invalidateItem(parent.item);
    }

    private getDropInfo(evt: DragEvent, readExternalData: boolean) {
        // clientY and getBoundingClientRect().top are both viewport relative. pageY is not --
        // mixing them offsets every drop by the page scroll.
        const box = this.element.nativeElement.getBoundingClientRect(),
            yPos = evt.clientY - box.top,
            target = this.getItemPosition(yPos),
            draggedItem = evt.dataTransfer!.types.includes(`text/plain.${this.ownId}`)
                ? this.ownDragItem
                : readExternalData
                    ? this.readExternalDragData(evt)
                    : undefined;

        return {
            draggedItem,
            index: target.itemIndex,
            parent: target.item,
            flatIndex: target.flatIndex,
            area: target.area,
            canDrop: () => {
                const item = draggedItem instanceof Node ? draggedItem.item : draggedItem,
                    itemNode = this.model.getTreeNode(item),
                    parentNode = target.item!,
                    parent = target.item ? target.item.item : undefined,
                    index = target.itemIndex;

                return this.canDrop(itemNode, parentNode, item, parent, index);
            }
        };
    }

    private readExternalDragData(evt: DragEvent) {
        try {
            return JSON.parse(evt.dataTransfer!.getData(TREE_ITEM_MIME));
        } catch {
            // A foreign payload under our key must not throw out of a drop handler.
            return undefined;
        }
    }

    private getItemPosition(yPos: number) {
        const scroll = this.getScrollPos(),
            flatIndex = Math.floor((yPos + scroll) / this.itemHeight),
            itemPos = flatIndex * this.itemHeight - scroll,
            buffer = this.itemHeight / 4,
            area = this.constrainDropPosition(
                itemPos + buffer > yPos ? 'before' : itemPos + this.itemHeight - buffer < yPos ? 'after' : 'on'
            ),
            itemAtIndex = this.model.items[flatIndex],
            itemIndex =
                !itemAtIndex || !itemAtIndex.parent
                    ? undefined
                    : area === 'before'
                        ? itemAtIndex.index
                        : area === 'after'
                            ? itemAtIndex.index + 1
                            : undefined,
            item = !itemAtIndex ? undefined : area === 'on' ? itemAtIndex : itemAtIndex.parent;

        return { flatIndex, itemIndex, item, area };
    }

    /**
     * Fold a computed drop position down to one the config permits.
     *
     * A tree restricted to `['on']` -- zTree's reparent-only mode -- should treat the edge bands of a
     * row as "drop onto it" rather than refusing the drop, so the whole row stays a valid target.
     */
    private constrainDropPosition(area: DragPos): DragPos {
        const allowed = this.config.allowedDropPositions;

        if (!allowed || !allowed.length || allowed.includes(area)) {
            return area;
        }

        return allowed.includes('on') ? 'on' : allowed[0];
    }

    private getDragData(item: any) {
        return this.config.getDragData(item);
    }

    private canDrop(itemNode: Node<any> | undefined, parentNode: Node<any>, item: any, parent: any, index: number | undefined) {
        return this.config.canDrop({ itemNode, parentNode, item, parent, index });
    }

    private adjustDragOverlay(dropInfo: { flatIndex: number; index: number | undefined; area: DragPos } | undefined) {
        if (this.dragOverlay && this.dragOverlay.nativeElement) {
            const el = this.dragOverlay.nativeElement;
            if (dropInfo) {
                const buffer = this.itemHeight / 4,
                    baseY = dropInfo.flatIndex * this.itemHeight,
                    y = dropInfo.area === 'before' ? baseY - buffer : dropInfo.area === 'after' ? baseY + this.itemHeight - buffer : baseY,
                    h = dropInfo.area === 'on' ? this.itemHeight : buffer * 2;

                el.style.top = y + 'px';
                el.style.height = h + 'px';
                if (dropInfo.area === 'on') {
                    el.classList.remove('i2v-dragoverlay-between');
                } else {
                    el.classList.add('i2v-dragoverlay-between');
                }
            } else {
                el.style.height = '0px';
            }
        }
    }

    private getChildren(item: any) {
        const result = this.childAccessor(item);
        if (result instanceof Promise) {
            this.loadChildren(item, result);
            return undefined;
        }
        return result;
    }

    private async loadChildren(item: any, childrenPromise: Promise<any>) {
        this.loadingItems.add(item);
        try {
            await childrenPromise;
        } finally {
            // Clear before invalidating: invalidateItem is what repaints, so doing it the other way
            // round leaves the row painted as still loading. The finally covers the failure path too.
            this.loadingItems.delete(item);
            if (!this.destroyed) {
                this.model.invalidateItem(item);
            }
        }
    }

    private handleFilterTextChange(value: string | undefined) {
        if (value && value.length >= this.config.filterTextMinLength) {
            this.setTextFilter(value);
        } else {
            this.clearTextFilter();
        }
        this._filterText = value;
        // Match highlighting reads the term directly, so it updates before the throttled filter
        // runs. Nothing else marks this OnPush view dirty when the input is set imperatively.
        this.cdr.markForCheck();
    }

    private setTextFilter(value: string) {
        const text = value.toLowerCase();

        clearTimeout(this.filterTextThrottle);
        this.filterTextThrottle = setTimeout(() => {
            if (this.destroyed) {
                return;
            }
            this.model.setFilter(item =>
                this.getName(item)
                    .toLowerCase()
                    .indexOf(text) >= 0
            );
        }, this.config.filterThrottle);
    }

    private clearTextFilter() {
        if (this._filterText && this._filterText.length >= this.config.filterTextMinLength) {
            clearTimeout(this.filterTextThrottle);
            this.model.setFilter(undefined);
            this.model.expandToSelectedItem();
            this.scrollToSelected();
        }
    }

    private listenToModel(model: I2vTree<any>) {
        this.dispose();
        const subscriptions = [
            model.onDataInvalidated.subscribe(() => this.handleDataChange()),
            // Selection and highlight do not rebuild the item list, so when a caller drives the
            // model directly nothing else would mark this OnPush view dirty.
            model.onSelectionChanged.subscribe((item: any) => {
                this.cdr.markForCheck();
                this.selectionChange.emit(item);
            }),
            model.onHighlightChanged.subscribe(() => this.cdr.markForCheck()),
            // Same reason: checking a box changes no row's existence, so without this a tri-state
            // checkbox driven from code never repaints.
            model.checks.onCheckStateChanged.subscribe(() => this.cdr.markForCheck())
        ];
        this.disposers.push(() => subscriptions.forEach(s => s.unsubscribe()));
    }

    private dispose() {
        for (const disposer of this.disposers) {
            disposer();
        }
        this.disposers.length = 0;
    }

    private handleDataChange() {
        if (this.destroyed) {
            return;
        }
        this.renderArea.itemCount = this.model.items.length;
        this.updateVisibleItems();
        this.refresh();
    }

    private refresh() {
        if (this.destroyed) {
            return;
        }
        if (this.viewInitialized) {
            this.cdr.detectChanges();
        } else {
            // Before the view exists the content query has not resolved, so forcing a pass here
            // would render one throwaway frame of built-in rows and then swap to the real template.
            this.cdr.markForCheck();
        }
    }

    private updateVisibleItems() {
        this.visibleItems = this.model.items.slice(
            this.renderArea.visibleStart,
            this.renderArea.visibleStart + this.renderArea.visibleCount
        );
    }
}
