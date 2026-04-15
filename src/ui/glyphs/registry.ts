/**
 * Centralized glyph registry — single source of truth for all unicode/ascii symbol pairs.
 *
 * Every glyph used in the UI must be defined here with both a unicode and ascii variant.
 * Color application is separate (done at call sites via chalk).
 */

export type GlyphKey =
	// Feed
	| 'feed.expandCollapsed'
	| 'feed.expandExpanded'
	| 'feed.searchMatch'
	// Todo
	| 'todo.doing'
	| 'todo.done'
	| 'todo.open'
	| 'todo.blocked'
	| 'todo.failed'
	| 'todo.caret'
	| 'todo.scrollUp'
	| 'todo.scrollDown'
	// Frame
	| 'frame.topLeft'
	| 'frame.topRight'
	| 'frame.bottomLeft'
	| 'frame.bottomRight'
	| 'frame.horizontal'
	| 'frame.vertical'
	| 'frame.teeLeft'
	| 'frame.teeRight'
	// Status
	| 'status.active'
	| 'status.error'
	| 'status.pending'
	| 'status.passthrough'
	| 'status.blocked'
	| 'status.streaming'
	| 'status.idle'
	// Tool
	| 'tool.bullet'
	| 'tool.gutter'
	| 'tool.arrow'
	| 'tool.success'
	| 'tool.failure'
	| 'tool.pending'
	// Subagent
	| 'subagent.pending'
	| 'subagent.passthrough'
	| 'subagent.start'
	| 'subagent.done'
	// Task
	| 'task.completed'
	| 'task.pending'
	| 'task.failed'
	| 'task.collapsed'
	| 'task.expanded'
	// Progress
	| 'progress.filled'
	| 'progress.empty'
	| 'progress.track'
	// Message
	| 'message.user'
	| 'message.agent'
	| 'message.indicator'
	// Permission
	| 'permission.warn'
	| 'permission.timeout'
	// Stop
	| 'stop.icon'
	// Config
	| 'config.icon'
	// General
	| 'general.ellipsis'
	| 'general.divider'
	// Feed visual polish
	| 'feed.userBorder'
	| 'feed.focusBorder'
	// Hints
	| 'hint.enter'
	| 'hint.escape'
	| 'hint.tab'
	| 'hint.arrows'
	| 'hint.arrowsUpDown'
	| 'hint.space'
	| 'hint.page'
	| 'hint.separator'
	| 'hint.toggle';

export const GLYPH_REGISTRY: Record<
	GlyphKey,
	{unicode: string; ascii: string}
> = {
	// Feed
	'feed.expandCollapsed': {unicode: '▸', ascii: '>'},
	'feed.expandExpanded': {unicode: '▾', ascii: 'v'},
	'feed.searchMatch': {unicode: '▌', ascii: '|'},

	// Todo
	'todo.doing': {unicode: '■', ascii: '*'},
	'todo.done': {unicode: '✓', ascii: 'x'},
	'todo.open': {unicode: '□', ascii: '-'},
	'todo.blocked': {unicode: '□', ascii: '-'},
	'todo.failed': {unicode: '✗', ascii: '!'},
	'todo.caret': {unicode: '▶', ascii: '>'},
	'todo.scrollUp': {unicode: '▲', ascii: '^'},
	'todo.scrollDown': {unicode: '▼', ascii: 'v'},

	// Frame (box-drawing)
	'frame.topLeft': {unicode: '┌', ascii: '+'},
	'frame.topRight': {unicode: '┐', ascii: '+'},
	'frame.bottomLeft': {unicode: '└', ascii: '+'},
	'frame.bottomRight': {unicode: '┘', ascii: '+'},
	'frame.horizontal': {unicode: '─', ascii: '-'},
	'frame.vertical': {unicode: '│', ascii: '|'},
	'frame.teeLeft': {unicode: '├', ascii: '+'},
	'frame.teeRight': {unicode: '┤', ascii: '+'},

	// Status
	'status.active': {unicode: '◉', ascii: '*'},
	'status.error': {unicode: '■', ascii: '!'},
	'status.pending': {unicode: '○', ascii: 'o'},
	'status.passthrough': {unicode: '▸', ascii: '>'},
	'status.blocked': {unicode: '✗', ascii: 'x'},
	'status.streaming': {unicode: '◐', ascii: '~'},
	'status.idle': {unicode: '⏸', ascii: '-'},

	// Tool
	'tool.bullet': {unicode: '●', ascii: '*'},
	'tool.gutter': {unicode: '⎿', ascii: '|'},
	'tool.arrow': {unicode: '→', ascii: '->'},
	'tool.success': {unicode: '✔', ascii: '+'},
	'tool.failure': {unicode: '✘', ascii: '!'},
	'tool.pending': {unicode: '◐', ascii: '~'},

	// Subagent
	'subagent.pending': {unicode: '◇', ascii: 'o'},
	'subagent.passthrough': {unicode: '◆', ascii: '*'},
	'subagent.start': {unicode: '↯', ascii: '*'},
	'subagent.done': {unicode: '⏹', ascii: '.'},

	// Task
	'task.completed': {unicode: '✓', ascii: 'x'},
	'task.pending': {unicode: '·', ascii: '.'},
	'task.failed': {unicode: '✗', ascii: '!'},
	'task.collapsed': {unicode: '▶', ascii: '>'},
	'task.expanded': {unicode: '▼', ascii: 'v'},

	// Progress
	'progress.filled': {unicode: '█', ascii: '='},
	'progress.empty': {unicode: '░', ascii: '-'},
	'progress.track': {unicode: '█', ascii: '-'},

	// Message
	'message.user': {unicode: '❯', ascii: '>'},
	'message.agent': {unicode: '▹', ascii: '>'},
	'message.indicator': {unicode: '┃', ascii: '|'},

	// Permission
	'permission.warn': {unicode: '⚠', ascii: '!'},
	'permission.timeout': {unicode: '⧗', ascii: '?'},

	// Stop
	'stop.icon': {unicode: '⊘', ascii: 'X'},

	// Config
	'config.icon': {unicode: '⚙', ascii: '*'},

	// General
	'general.ellipsis': {unicode: '…', ascii: '...'},
	'general.divider': {unicode: '─', ascii: '-'},
	// Feed visual polish
	'feed.userBorder': {unicode: '▎', ascii: '|'},
	'feed.focusBorder': {unicode: '▎', ascii: '|'},

	// Hints
	'hint.enter': {unicode: '↵', ascii: 'Enter'},
	'hint.escape': {unicode: 'esc', ascii: 'Esc'},
	'hint.tab': {unicode: 'tab', ascii: 'Tab'},
	'hint.arrows': {unicode: '↑↓', ascii: 'C-Up/Dn'},
	'hint.arrowsUpDown': {unicode: '↑↓', ascii: 'Up/Dn'},
	'hint.space': {unicode: 'space', ascii: 'Space'},
	'hint.page': {unicode: 'pgup/dn', ascii: 'PgUp/Dn'},
	'hint.separator': {unicode: ' ', ascii: '|'},
	'hint.toggle': {unicode: '⌃/', ascii: 'C-/'},
};
