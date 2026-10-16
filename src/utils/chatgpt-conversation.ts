// ChatGPT only keeps the turns near the viewport mounted in the DOM. Long
// conversations therefore clip as a fragment, because Defuddle only sees what
// is mounted. This module scrolls the conversation once, collects every turn
// as it mounts, and returns a document with the complete conversation for
// Defuddle's ChatGPT extractor to parse.

import { debugLog } from './debug';

// The containers Defuddle's ChatGPT extractor reads: one per exchange in the
// current layout ([data-turn-key]), one per message in the older one.
export const TURN_SELECTOR = '[data-turn-key], [data-testid^="conversation-turn-"]';

const CHATGPT_HOSTS = ['chatgpt.com', 'chat.openai.com'];

export interface ScrollView {
	getScrollTop(): number;
	setScrollTop(top: number): void;
	getScrollHeight(): number;
	getClientHeight(): number;
	getTurnHeight(turn: Element): number;
}

export interface CollectOptions {
	// Fraction of the visible height to move per step.
	stepFraction?: number;
	// How long the DOM must stay unchanged before a step counts as rendered.
	quietMs?: number;
	// Upper bound on waiting for a single step to render.
	maxStepWaitMs?: number;
	// Upper bound for the whole pass; whatever was collected is used after it.
	maxTotalMs?: number;
}

const DEFAULTS: Required<CollectOptions> = {
	stepFraction: 0.75,
	quietMs: 150,
	maxStepWaitMs: 1500,
	maxTotalMs: 60000,
};

export function isChatGPTUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return CHATGPT_HOSTS.some(h => host === h || host.endsWith('.' + h));
	} catch {
		return false;
	}
}

// Turns in document order, ignoring any turn nested inside another.
export function getMountedTurns(root: ParentNode): Element[] {
	return Array.from(root.querySelectorAll(TURN_SELECTOR))
		.filter(el => !el.parentElement?.closest(TURN_SELECTOR));
}

export function getTurnKey(turn: Element): string {
	return turn.getAttribute('data-turn-key')
		|| turn.querySelector('[data-message-id]')?.getAttribute('data-message-id')
		|| turn.getAttribute('data-turn-id')
		|| turn.querySelector('[data-turn-id]')?.getAttribute('data-turn-id')
		|| turn.getAttribute('data-testid')
		|| '';
}

// Ordered collection of turns seen across scroll positions. Each pass only
// shows a window of the conversation, so new turns are placed relative to
// turns already known from earlier passes.
export class TurnCollection {
	private order: string[] = [];
	private turns = new Map<string, Element>();

	get size(): number {
		return this.order.length;
	}

	// Returns the number of previously unseen turns.
	capture(mounted: Element[]): number {
		const entries = mounted
			.map(el => ({ key: getTurnKey(el), el }))
			.filter(entry => entry.key);
		let added = 0;
		let insertAt = this.firstKnownIndex(entries.map(e => e.key));

		for (const { key, el } of entries) {
			const existing = this.turns.get(key);
			if (existing) {
				insertAt = this.order.indexOf(key) + 1;
				// A later render of the same turn can be more complete
				// (images, code blocks), so keep the fuller version.
				if (el.outerHTML.length > existing.outerHTML.length) {
					this.turns.set(key, el.cloneNode(true) as Element);
				}
				continue;
			}
			this.order.splice(insertAt, 0, key);
			this.turns.set(key, el.cloneNode(true) as Element);
			insertAt++;
			added++;
		}
		return added;
	}

	toArray(): Element[] {
		return this.order.map(key => this.turns.get(key)!);
	}

	has(key: string): boolean {
		return this.turns.has(key);
	}

	// New turns that come before every known turn go in front of the first
	// known one; with nothing known yet they go at the end.
	private firstKnownIndex(keys: string[]): number {
		for (const key of keys) {
			const index = this.order.indexOf(key);
			if (index !== -1) return index;
		}
		return this.order.length;
	}
}

export function findScrollContainer(doc: Document): Element {
	const view = doc.defaultView;
	let el = getMountedTurns(doc)[0]?.parentElement ?? null;
	while (el && el !== doc.body && view) {
		const { overflowY } = view.getComputedStyle(el);
		if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
			return el;
		}
		el = el.parentElement;
	}
	return doc.scrollingElement || doc.documentElement;
}

export function createScrollView(container: Element): ScrollView {
	return {
		getScrollTop: () => container.scrollTop,
		setScrollTop: (top: number) => container.scrollTo({ top, behavior: 'instant' as ScrollBehavior }),
		getScrollHeight: () => container.scrollHeight,
		getClientHeight: () => container.clientHeight,
		getTurnHeight: (turn: Element) => turn.getBoundingClientRect().height,
	};
}

// True when some turns are not mounted, judged by comparing the height of
// the mounted turns to the scrollable height.
export function hasUnmountedTurns(doc: Document, view: ScrollView): boolean {
	const mounted = getMountedTurns(doc);
	if (mounted.length === 0) return false;
	const clientHeight = view.getClientHeight();
	const scrollHeight = view.getScrollHeight();
	if (scrollHeight <= clientHeight) return false;
	const mountedHeight = mounted.reduce((sum, turn) => sum + view.getTurnHeight(turn), 0);
	// Allow a viewport of slack for the composer, header and spacing.
	return mountedHeight < scrollHeight - clientHeight;
}

// Resolves once the DOM under `root` has been quiet for `quietMs`, or after
// `maxMs`, whichever comes first.
export function waitForQuiet(root: Node, quietMs: number, maxMs: number): Promise<void> {
	return new Promise(resolve => {
		let quietTimer: ReturnType<typeof setTimeout>;
		const finish = () => {
			observer.disconnect();
			clearTimeout(quietTimer);
			clearTimeout(maxTimer);
			resolve();
		};
		const observer = new MutationObserver(() => {
			clearTimeout(quietTimer);
			quietTimer = setTimeout(finish, quietMs);
		});
		observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
		quietTimer = setTimeout(finish, quietMs);
		const maxTimer = setTimeout(finish, maxMs);
	});
}

// Scrolls from the bottom of the conversation to the top, collecting turns,
// then puts the scroll position back where it was.
export async function collectAllTurns(doc: Document, view: ScrollView, options: CollectOptions = {}): Promise<TurnCollection> {
	const opts = { ...DEFAULTS, ...options };
	const collection = new TurnCollection();
	const startTop = view.getScrollTop();
	const deadline = Date.now() + opts.maxTotalMs;
	const settle = () => waitForQuiet(doc.body, opts.quietMs, opts.maxStepWaitMs);

	try {
		collection.capture(getMountedTurns(doc));
		view.setScrollTop(view.getScrollHeight());
		await settle();
		collection.capture(getMountedTurns(doc));

		let stuckSteps = 0;
		while (Date.now() < deadline) {
			const top = view.getScrollTop();
			const step = Math.max(200, Math.floor(view.getClientHeight() * opts.stepFraction));
			view.setScrollTop(Math.max(0, top - step));
			await settle();
			const added = collection.capture(getMountedTurns(doc));
			const newTop = view.getScrollTop();
			// Stop only at the top when nothing new appeared there, since
			// older turns can load in after reaching it.
			if (top <= 0 && newTop <= 0 && added === 0) break;
			// Give up if scrolling has no effect (wrong container).
			stuckSteps = newTop === top && added === 0 ? stuckSteps + 1 : 0;
			if (stuckSteps >= 3) {
				debugLog('ChatGPT', 'Scroll position stopped changing at', top);
				break;
			}
		}
		if (Date.now() >= deadline) {
			debugLog('ChatGPT', 'Stopped collecting turns at time limit with', collection.size, 'turns');
		}
	} finally {
		view.setScrollTop(startTop);
	}
	return collection;
}

// Copy of `doc` in which the mounted turns are replaced by `turns`. Cloned
// rather than re-parsed, since ChatGPT nests elements in ways an HTML parser
// would rearrange (block badges inside paragraphs).
export function buildConversationDocument(doc: Document, turns: Element[]): Document {
	const copy = doc.cloneNode(true) as Document;
	const mounted = getMountedTurns(copy);
	if (mounted.length === 0 || turns.length === 0) return copy;
	const fragment = copy.createDocumentFragment();
	for (const turn of turns) {
		fragment.appendChild(copy.importNode(turn, true));
	}
	mounted[0].parentNode!.insertBefore(fragment, mounted[0]);
	mounted.forEach(turn => turn.remove());
	return copy;
}

interface CachedConversation {
	url: string;
	collection: TurnCollection;
	collectedAt: number;
}

const CACHE_MS = 5 * 60 * 1000;
let cache: CachedConversation | null = null;
let inFlight: Promise<Document | null> | null = null;

// Returns a document with the full conversation, or null when the page
// isn't a ChatGPT conversation or every turn is already mounted.
export function getFullChatGPTConversation(doc: Document, options: CollectOptions = {}, view?: ScrollView): Promise<Document | null> {
	if (!isChatGPTUrl(doc.URL)) return Promise.resolve(null);
	if (inFlight) return inFlight;

	inFlight = (async () => {
		const mounted = getMountedTurns(doc);
		if (mounted.length === 0) return null;

		// Reuse the last pass while every mounted turn is already in it, so
		// switching templates in the popup doesn't scroll again. A new
		// message produces an unknown turn and triggers a fresh pass.
		if (cache && cache.url === doc.URL && Date.now() - cache.collectedAt < CACHE_MS
			&& mounted.every(turn => cache!.collection.has(getTurnKey(turn)))) {
			return buildConversationDocument(doc, cache.collection.toArray());
		}

		const scrollView = view ?? createScrollView(findScrollContainer(doc));
		if (!hasUnmountedTurns(doc, scrollView)) return null;

		const started = Date.now();
		const collection = await collectAllTurns(doc, scrollView, options);
		debugLog('ChatGPT', `Collected ${collection.size} turns in ${Date.now() - started}ms`);

		cache = { url: doc.URL, collection, collectedAt: Date.now() };
		return buildConversationDocument(doc, collection.toArray());
	})().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

export function clearConversationCache(): void {
	cache = null;
}
