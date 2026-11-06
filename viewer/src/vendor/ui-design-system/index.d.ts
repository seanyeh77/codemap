import type * as React from 'react';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary: the one main action per view. secondary (default): outline. danger: destructive. */
  variant?: 'primary' | 'secondary' | 'danger';
  /** Shows a spinner, disables the button; pair with a progressive label such as 儲存中. */
  loading?: boolean;
  /** SVG path data for a leading 24 px line icon. */
  icon?: string;
}
export declare function Button(props: ButtonProps): React.ReactElement;
export interface IconProps { /** Phosphor icon name, e.g. 'house', 'trash' (Lucide names work as aliases). */ name?: string; /** Path data, or SVG markup, when the icon is not built in. */ d?: string; /** Default 20. */ size?: number; strokeWidth?: number; /** Use the Fill version (for a selected item). */ filled?: boolean; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: becomes aria-label and tooltip. */
  label: string;
  icon?: string;
  /** Set false to skip the Tooltip. Default true. */
  tooltip?: boolean;
}
export declare function IconButton(props: IconButtonProps): React.ReactElement;
export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Shows a red asterisk after the label. */
  required?: boolean;
  hint?: string;
  /** Error message; turns the border danger and adds the alert icon. */
  error?: string;
}
export declare function TextField(props: TextFieldProps): React.ReactElement;
export interface CheckboxProps { checked?: boolean | 'mixed'; onChange?: (v: boolean) => void; label?: string; disabled?: boolean; className?: string }
export declare function Checkbox(props: CheckboxProps): React.ReactElement;
export interface RadioGroupProps { label?: string; value?: string; onChange?: (v: string) => void; options: { value: string; label: string; disabled?: boolean }[]; disabled?: boolean; className?: string }
export declare function RadioGroup(props: RadioGroupProps): React.ReactElement;
export interface SwitchProps { checked?: boolean; onChange?: (v: boolean) => void; /** Required: aria-label. */ label: string; disabled?: boolean; className?: string }
export declare function Switch(props: SwitchProps): React.ReactElement;
export interface SelectProps { label?: string; value?: string; onChange?: (v: string) => void; options: { value: string; label: string }[]; /** Default: true when there are more than 8 options. */ searchable?: boolean; placeholder?: string; searchPlaceholder?: string; required?: boolean; disabled?: boolean; className?: string }
export declare function Select(props: SelectProps): React.ReactElement;
export interface SearchFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> { value: string; onChange: (v: string) => void; label?: string }
export declare function SearchField(props: SearchFieldProps): React.ReactElement;
export interface TextAreaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> { label?: string; hint?: string; value: string; onChange: (v: string) => void; maxLength?: number; required?: boolean }
export declare function TextArea(props: TextAreaProps): React.ReactElement;
export interface FormGridProps { children?: React.ReactNode; className?: string }
export declare function FormGrid(props: FormGridProps): React.ReactElement;
export interface KpiCardProps { label: string; value: number; /** 'money' shows NT$; 'percent' 1 decimal. */ format?: 'number' | 'money' | 'percent'; currency?: string; /** Abbreviate 1 萬 and above (default true). */ compact?: boolean; /** Written after the number, e.g. 元, 人, ms, %. */ unit?: string; decimals?: number; /** Change versus the comparison period. */ delta?: number; /** '%' (default) or 'pt' for percentage points. */ deltaUnit?: '%' | 'pt'; /** Whether the change is good. Defaults to delta > 0; set false for metrics where up is bad. */ good?: boolean; /** Recent values for the sparkline. */ spark?: number[]; compareLabel?: string; className?: string }
export declare function KpiCard(props: KpiCardProps): React.ReactElement;
export interface LineChartProps { series: { name: string; values: number[] }[]; labels: string[]; label: string; unit?: string; max?: number; labelEvery?: number; className?: string }
export declare function LineChart(props: LineChartProps): React.ReactElement;
export interface BarChartProps { data: { label: string; short?: string; value: number }[]; label: string; unit?: string; max?: number; className?: string }
export declare function BarChart(props: BarChartProps): React.ReactElement;
export interface ProgressBarProps { value: number; label?: string; className?: string }
export declare function ProgressBar(props: ProgressBarProps): React.ReactElement;
export interface LoadingBarProps { label?: string; className?: string }
export declare function LoadingBar(props: LoadingBarProps): React.ReactElement;
export interface ProgressRingProps { value: number; label: string; size?: number; className?: string }
export declare function ProgressRing(props: ProgressRingProps): React.ReactElement;
export interface TooltipProps { /** The text. Also used as the trigger's description for screen readers. */ label: string; /** Preferred side; flips to the other side when there is no room. Default 'top'. */ side?: 'top' | 'bottom'; /** One focusable element. */ children: React.ReactElement }
export declare function Tooltip(props: TooltipProps): React.ReactElement;
export interface MenuItem { label: string; icon?: string; shortcut?: string; /** Red, moved to the end after a divider. */ danger?: boolean; disabled?: boolean; onSelect?: () => void }
export interface MenuProps { items: MenuItem[]; /** aria-label of the ⋯ button. Default 「更多操作」. */ label?: string; icon?: string; /** 'end' lines up right edges (default); flips to 'start' when the menu would leave the window. */ align?: 'end' | 'start'; /** Extra class on the ⋯ button. */ triggerClassName?: string }
export declare function Menu(props: MenuProps): React.ReactElement;
export interface PopoverProps { /** Text of the trigger button. */ label: string; icon?: string; count?: number | string; title?: string; side?: 'top' | 'bottom'; align?: 'end' | 'start' | 'center'; /** Content, or a function that receives close(). */ children?: React.ReactNode | ((close: () => void) => React.ReactNode); triggerClassName?: string }
export declare function Popover(props: PopoverProps): React.ReactElement;
export interface DrawerProps { open: boolean; onClose: () => void; title: string; /** Footer buttons: secondary first, primary last. */ actions?: React.ReactNode; /** When true, closing asks 「放棄未儲存的變更？」 first. */ dirty?: boolean; width?: number; confirmTitle?: string; confirmText?: string; children?: React.ReactNode }
export declare function Drawer(props: DrawerProps): React.ReactElement | null;
export declare function t(key: string, vars?: Record<string, string | number>): string;
export declare function setLocale(locale: string, opts?: { currency?: string }): void;
export declare function addMessages(locale: string, dict: Record<string, string>): void;
export declare const format: {
  /** Keeps the first segment and the last two: 「src/…/hooks/ops.c:58」. */
  path(path: string, o?: { head?: number; tail?: number }): string;
  /** Bytes to 「186 KB」「54.9 MB」. */
  fileSize(bytes: number): string;
  locale(): string;
  date(d: Date, opts?: { weekday?: boolean; long?: boolean }): string;
  time(d: Date): string;
  dateTime(d: Date, opts?: { weekday?: boolean }): string;
  relative(d: Date, now?: Date): string;
  month(d: Date): string;
  weekdays(): string[];
  firstDay(): number;
  number(v: number, dec?: number | 'money' | 'percent' | 'size' | 'count'): string;
  percent(v: number, dec?: number): string;
  compact(v: number): string;
  money(v: number, opts?: { currency?: string; compact?: boolean }): string;
};
export declare function setTheme(theme: 'auto' | 'light' | 'dark'): void;
export declare function setAccent(hex: string): boolean;
export declare function initTheme(): void;
export interface ThemePickerProps { value?: 'auto' | 'light' | 'dark'; onChange?: (v: 'auto' | 'light' | 'dark') => void; label?: string; className?: string }
export declare function ThemePicker(props: ThemePickerProps): React.ReactElement;
export interface AccentPickerProps { value?: string; onChange?: (hex: string) => void; label?: string; className?: string }
export declare function AccentPicker(props: AccentPickerProps): React.ReactElement;
export interface NotificationItem { id: string | number; title: string; body?: string; time?: string; /** Group heading, e.g. 今天, 更早. Items must already be newest first. */ group?: string; read?: boolean }
export interface NotificationBellProps { items: NotificationItem[]; onOpen?: (item: NotificationItem) => void; onReadAll?: () => void; emptyText?: string }
export declare function NotificationBell(props: NotificationBellProps): React.ReactElement;
export interface DatePickerProps { label?: string; value: Date | null; onChange: (d: Date | null) => void; hint?: string; required?: boolean; className?: string }
export declare function DatePicker(props: DatePickerProps): React.ReactElement;
export interface DateRangePickerProps { label?: string; value: [Date | null, Date | null]; onChange: (r: [Date, Date]) => void; placeholder?: string; className?: string }
export declare function DateRangePicker(props: DateRangePickerProps): React.ReactElement;
export interface UploadFile { id?: string | number; name: string; size?: string; progress?: number; status?: 'uploading' | 'done' | 'error'; /** Reason plus fix, shown in red. */ error?: string }
export interface FileUploadProps { label?: string; files?: UploadFile[]; onAdd?: (files: File[]) => void; onRemove?: (f: UploadFile) => void; onRetry?: (f: UploadFile) => void; /** Written inside the drop zone, e.g. 每個最大 100 MB. */ limitText?: string; accept?: string; multiple?: boolean; className?: string }
export declare function FileUpload(props: FileUploadProps): React.ReactElement;
export interface MultiSelectProps { label?: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; /** Allow adding values that are not in options. */ creatable?: boolean; /** Chips shown before 「+n」. Default 2. */ maxChips?: number; placeholder?: string; emptyText?: string; className?: string }
export declare function MultiSelect(props: MultiSelectProps): React.ReactElement;
export interface ErrorPageProps { code: 404 | 500 | 403 | number; title?: string; description?: string; onBack?: () => void; onHome?: () => void; homeHref?: string; className?: string }
export declare function ErrorPage(props: ErrorPageProps): React.ReactElement;
export interface LoginCardProps { brand?: React.ReactNode; title?: string; onSubmit: (v: { account: string; password: string }) => void; error?: { account?: string; password?: string } | null; forgotHref?: string; loading?: boolean; className?: string }
export declare function LoginCard(props: LoginCardProps): React.ReactElement;
export interface SettingsLayoutProps { title?: string; categories: { id: string; label: string; content: React.ReactNode }[]; value?: string; onChange?: (id: string) => void; /** Text for the 「已儲存」 toast; empty hides it. */ toast?: string; className?: string }
export declare function SettingsLayout(props: SettingsLayoutProps): React.ReactElement;
export declare function SettingsSection(props: { title?: string; description?: string; children?: React.ReactNode; className?: string }): React.ReactElement;
export interface DangerZoneProps { title?: string; description: string; actionLabel?: string; onAction: () => void; className?: string }
export declare function DangerZone(props: DangerZoneProps): React.ReactElement;
export interface BadgeProps { status: 'draft' | 'doing' | 'review' | 'done' | 'fail'; /** 'dot' on cards: dot plus colored text, no chip. */ variant?: 'chip' | 'dot'; children?: React.ReactNode; className?: string }
export declare function Badge(props: BadgeProps): React.ReactElement;
export interface AlertProps { tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string; children?: React.ReactNode; actionLabel?: string; onAction?: () => void; /** Shown only for info and success. */ onDismiss?: () => void; className?: string }
export declare function Alert(props: AlertProps): React.ReactElement;
export interface DataTableColumn { key: string; label: string; numeric?: boolean; /** Appended after each value, e.g. '%', 'ms', '個'. */ unit?: string; render?: (row: any) => React.ReactNode; sortable?: boolean; sortValue?: (row: any) => number | string; width?: number; grow?: number; format?: 'money' | 'date' | 'datetime' | 'relative' | 'percent'; currency?: string; decimals?: number; searchText?: (row: any) => string; /** Place on phone cards: title row left, title row right, or hidden. Default: first column is the title. */ mobile?: 'title' | 'status' | 'hide'; /** Long text: 2 lines with 「顯示全部」 on phone cards, one line with an ellipsis on desktop. */ long?: boolean }
export interface DataTableProps {
  columns: DataTableColumn[]; rows: any[]; caption?: string;
  /** Segmented summary above the table: 「全部」 plus one tab per status, each with its count; picking one filters the rows. */
  summary?: { key: string; items: { value: any; label: string }[]; label?: string };
  /** aria-label for the table when there is no caption. */ label?: string;
  /** Rows per page. Default 10. */ pageSize?: number;
  /** Change it when the rows become a different data set: search, filters, sort, page, selection and summary reset. */ resetKey?: string | number;
  /** Checkboxes appear when a row is hovered, and on every row once any row is selected. */ selectable?: boolean;
  /** Buttons for the bar that replaces the header while rows are selected. */ bulkActions?: (ids: string[], clear: () => void) => React.ReactNode;
  /** Icon buttons shown at the row's right end when the row is hovered. Use IconButton. */ rowActions?: (row: any) => React.ReactNode; actionsWidth?: number;
  /** Search box (default on; false hides it). Searches every column unless keys is given. */ search?: false | { placeholder?: string; keys?: string[] };
  /** Filters shown in the 「篩選」 popover. */ filters?: { key: string; label: string; type?: 'list' | 'range'; options?: { value: string; label: string }[]; /** Default true. */ multiple?: boolean; scale?: number; unitLabel?: string; match?: (row: any, value: any) => boolean }[];
  /** Old single-field filter; converted to one list filter. */ filter?: { key: string; label?: string; options: { value: string; label: string }[] };
  /** Write search and filters into the URL (default true). */ urlSync?: boolean; urlKey?: string;
  /** Saved views shown as tabs above the table. */ views?: { id: string; label: string; filter?: (row: any) => boolean }[];
  /** Totals row: 'sum', 'avg' or a function per column key. */ totals?: Record<string, 'sum' | 'avg' | ((rows: any[]) => React.ReactNode)>;
  /** Keep the first column visible while scrolling sideways. */ stickyFirst?: boolean;
  /** 「欄位」 menu to hide columns (default true). */ columnMenu?: boolean;
  emptyText?: string; className?: string;
}
export declare function DataTable(props: DataTableProps): React.ReactElement;
export interface SkeletonProps { width?: number | string; height?: number | string }
export declare function Skeleton(props: SkeletonProps): React.ReactElement;
export interface EmptyStateProps { title: string; description?: string; steps?: string[]; current?: number; action?: React.ReactNode }
export declare function EmptyState(props: EmptyStateProps): React.ReactElement;
export interface ToastProps { children?: React.ReactNode; actionLabel?: string; onAction?: () => void }
export declare function Toast(props: ToastProps): React.ReactElement;
export interface DialogProps { title: string; titleId?: string; modal?: boolean; onClose?: () => void; children?: React.ReactNode; actions?: React.ReactNode }
export declare function Dialog(props: DialogProps): React.ReactElement;
export interface NavItem { id: string; label: string; icon?: string; children?: NavItem[] }
export interface SideNavProps { sections: { items: NavItem[] }[]; value: string; onChange?: (id: string) => void; collapsed?: boolean; onToggle?: () => void; brand?: React.ReactNode; label?: string; className?: string }
export declare function SideNav(props: SideNavProps): React.ReactElement;
export interface BreadcrumbProps { items: { label: string; href?: string }[]; className?: string }
export declare function Breadcrumb(props: BreadcrumbProps): React.ReactElement;
export interface TopBarProps { /** Page title shown on the left. */ title?: string; breadcrumb?: { label: string; href?: string }[]; onSearch?: (() => void) | false; searchLabel?: string; children?: React.ReactNode; className?: string }
export declare function TopBar(props: TopBarProps): React.ReactElement;
export interface TabsProps { items: { id: string; label: string; count?: number }[]; value: string; onChange?: (id: string) => void; label?: string; className?: string }
export declare function Tabs(props: TabsProps): React.ReactElement;
export interface MobileTabBarProps { items: { id: string; label: string; icon: string }[]; value: string; onChange?: (id: string) => void; label?: string; className?: string }
export declare function MobileTabBar(props: MobileTabBarProps): React.ReactElement;
export interface InlineCodeProps { children: React.ReactNode; /** Makes it a link. */ href?: string; onClick?: (e: any) => void; className?: string }
export declare function InlineCode(props: InlineCodeProps): React.ReactElement;
export type RefHref = (ref: string) => string | undefined | null;
export type OnRef = (ref: string, e: React.MouseEvent<HTMLElement>) => void;
export interface CodeTextProps { /** Text with `backtick` spans. */ text: string; /** Spans that look like file.c:86 become links; return undefined when the reference has no target. */ refHref?: RefHref; /** Called on a plain click; the default navigation is prevented. */ onRef?: OnRef; isRef?: (span: string) => boolean; as?: string; className?: string }
export declare function CodeText(props: CodeTextProps): React.ReactElement;
export interface TreeNode { id: string; name: string; children?: TreeNode[]; ext?: string; date?: Date | number | string; size?: number; unseen?: boolean; /** kind="plain": location shown under the name (shortened with format.path). */ path?: string; /** kind="plain": text shown under the name instead of path. */ meta?: string; /** kind="plain": category tags shown after the name; text or elements such as UI.Term. */ tags?: React.ReactNode[]; /** Expandable before its children are loaded (with loadChildren). */ hasChildren?: boolean; /** kind="plain": name in secondary color. */ muted?: boolean; /** kind="plain": Phosphor icon name. */ icon?: string }
export interface TreeListProps { items: TreeNode[]; /** 'files' (default) or 'plain' for non-file trees such as call graphs. */ kind?: 'files' | 'plain'; /** kind="plain": the selected row. */ selectedId?: string; onSelect?: (node: TreeNode) => void; rowActions?: (node: TreeNode) => React.ReactNode; /** kind="plain": show 「全部展開」. */ toggleAll?: boolean; title?: React.ReactNode; label?: string; actions?: React.ReactNode; sort?: 'newest' | 'oldest' | 'name' | false; expand?: 'multi' | 'single'; defaultOpen?: string[]; /** Controlled open ids; update them in onToggle. */ open?: string[]; onToggle?: (node: TreeNode, isOpen: boolean, openIds: string[]) => void; /** Loads the children of a node with hasChildren when it is first opened. */ loadChildren?: (node: TreeNode) => TreeNode[] | Promise<TreeNode[]>; selectable?: boolean; selected?: string[]; onSelectChange?: (ids: string[]) => void; bulkActions?: (files: TreeNode[], clear: () => void) => React.ReactNode; onDownload?: (files: TreeNode[]) => void; onOpen?: (file: TreeNode) => void; emptyText?: string; className?: string }
export declare function TreeList(props: TreeListProps): React.ReactElement;
export declare function Tag(props: { children: React.ReactNode; className?: string }): React.ReactElement;
export interface ProjectSwitcherProps { project: string; status?: 'live' | 'stale' | 'offline'; statusLabel?: string; options?: { id: string; label: string; detail?: string }[]; value?: string; onChange?: (id: string) => void; footer?: React.ReactNode; className?: string }
export declare function ProjectSwitcher(props: ProjectSwitcherProps): React.ReactElement;
export declare function DetailList(props: { items: { label: string; value: React.ReactNode }[]; className?: string }): React.ReactElement;
export interface ActionBarAction { label: string; onClick?: () => void; primary?: boolean; icon?: string; disabled?: boolean; danger?: boolean }
export declare function ActionBar(props: { actions: ActionBarAction[]; className?: string }): React.ReactElement;
export interface PaletteItem { id?: string; label: string; /** Shown under the label; `backticks` are code. */ detail?: string; /** e.g. 函式, 檔案, 元件, 環境變數, 頁面. Picks the icon. */ kind?: string; /** Phosphor name; overrides the kind's icon. */ icon?: string; /** Label is code: Geist Mono. */ code?: boolean; keywords?: string[]; [key: string]: any }
export interface CommandPaletteProps { open: boolean; onOpenChange: (open: boolean) => void; items: PaletteItem[]; onSelect?: (item: PaletteItem) => void; placeholder?: string; /** Shown before anything is typed. */ recent?: PaletteItem[]; recentLabel?: string; emptyText?: string; /** Map kind to a Phosphor icon name. */ kinds?: Record<string, string>; /** false: items are already filtered (server search). */ filter?: boolean; onQueryChange?: (q: string) => void; loading?: boolean; limit?: number; /** Ctrl K / ⌘K opens it; default true. */ hotkey?: boolean; defaultQuery?: string; label?: string }
export declare function CommandPalette(props: CommandPaletteProps): React.ReactElement | null;
export interface TourStep { /** A data-tour name ('search' matches [data-tour="search"]), a CSS selector (first visible match), a ref or an element. */ target?: string | { current: Element | null } | Element; title: string; /** `backticks` are code. */ text: string; side?: 'bottom' | 'top'; padding?: number }
export interface TourProps { open: boolean; steps: TourStep[]; onClose?: (reason: 'done' | 'skip') => void; skippable?: boolean; step?: number; onStepChange?: (i: number) => void }
export declare function Tour(props: TourProps): React.ReactElement | null;
export declare function useTour(key: string): { open: boolean; start: () => void; close: () => void; seen: boolean };
export interface SuggestionProps { title?: string; before?: string; after: string; copyText?: string; copyLabel?: string; onCopy?: (text: string) => void; onCopyError?: () => void; refHref?: RefHref; onRef?: OnRef; isRef?: (span: string) => boolean; className?: string }
export declare function Suggestion(props: SuggestionProps): React.ReactElement;
export interface TermProps { children: React.ReactNode; title?: string; /** `backticks` are code. */ text?: string; content?: React.ReactNode; /** Evidence line, shown as a code block. */ code?: string; action?: { label: string; onClick?: () => void }; refHref?: RefHref; onRef?: OnRef; isRef?: (span: string) => boolean; className?: string }
export declare function Term(props: TermProps): React.ReactElement;
export declare function Calendar(props: { focus?: Date; onPick?: (d: Date) => void; onHover?: (d: Date | null) => void; dayState?: (d: Date) => { selected?: boolean; inRange?: boolean; disabled?: boolean } | undefined }): React.ReactElement;
/** Shared motion constants: droplet duration in ms and stretch factor. */
export declare const MOTION: { dur: number; stretch: number };
/** Phosphor icon paths by name (regular, plus fill variants). */
export declare const icons: Record<string, string>;
declare global { interface Window { UI: { Button: typeof Button; IconButton: typeof IconButton; TextField: typeof TextField; Checkbox: typeof Checkbox; RadioGroup: typeof RadioGroup; Switch: typeof Switch; Select: typeof Select; SearchField: typeof SearchField; TextArea: typeof TextArea; FormGrid: typeof FormGrid; t: typeof t; setLocale: typeof setLocale; addMessages: typeof addMessages; format: typeof format; ThemePicker: typeof ThemePicker; AccentPicker: typeof AccentPicker; setTheme: typeof setTheme; setAccent: typeof setAccent; initTheme: typeof initTheme; NotificationBell: typeof NotificationBell; DatePicker: typeof DatePicker; DateRangePicker: typeof DateRangePicker; Calendar: typeof Calendar; FileUpload: typeof FileUpload; MultiSelect: typeof MultiSelect; ErrorPage: typeof ErrorPage; LoginCard: typeof LoginCard; SettingsLayout: typeof SettingsLayout; SettingsSection: typeof SettingsSection; DangerZone: typeof DangerZone; Tooltip: typeof Tooltip; Menu: typeof Menu; Popover: typeof Popover; Drawer: typeof Drawer; KpiCard: typeof KpiCard; LineChart: typeof LineChart; BarChart: typeof BarChart; ProgressBar: typeof ProgressBar; LoadingBar: typeof LoadingBar; ProgressRing: typeof ProgressRing; Badge: typeof Badge; Alert: typeof Alert; DataTable: typeof DataTable; Skeleton: typeof Skeleton; EmptyState: typeof EmptyState; Toast: typeof Toast; Dialog: typeof Dialog; SideNav: typeof SideNav; TopBar: typeof TopBar; Breadcrumb: typeof Breadcrumb; Tabs: typeof Tabs; MobileTabBar: typeof MobileTabBar; TreeList: typeof TreeList; Tag: typeof Tag; ProjectSwitcher: typeof ProjectSwitcher; DetailList: typeof DetailList; ActionBar: typeof ActionBar; InlineCode: typeof InlineCode; CodeText: typeof CodeText; CommandPalette: typeof CommandPalette; Tour: typeof Tour; useTour: typeof useTour; Suggestion: typeof Suggestion; Term: typeof Term; MOTION: typeof MOTION; Icon: typeof Icon; icons: typeof icons } } }
