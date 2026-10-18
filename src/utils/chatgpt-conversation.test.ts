// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://chatgpt.com/c/test-conversation" }
import { afterEach, describe, expect, it } from 'vitest';
import Defuddle from 'defuddle';
import {
	TurnCollection,
	buildConversationDocument,
	clearConversationCache,
	collectAllTurns,
	getFullChatGPTConversation,
	getMountedTurns,
	isScrollable,
	isChatGPTUrl,
	ScrollView,
} from './chatgpt-conversation';

const TURN_HEIGHT = 100;
const VIEWPORT = 400;
// Turns this far outside the viewport stay mounted, like ChatGPT's overscan.
const OVERSCAN = 300;

function turnHtml(index: number): string {
	const role = index % 2 === 1 ? 'user' : 'assistant';
	const body = role === 'user'
		? `<div class="whitespace-pre-wrap">Question number ${index}</div>`
		: `<div class="markdown prose"><p>Answer number ${index}</p></div>`;
	return `<section data-testid="conversation-turn-${index}" data-turn="${role}">`
		+ `<h5 class="sr-only">${role === 'user' ? 'You said:' : 'ChatGPT said:'}</h5>`
		+ `<div data-message-author-role="${role}" data-message-id="msg-${index}">${body}</div>`
		+ `</section>`;
}

// A conversation that only mounts the turns near the viewport, and remounts
// them whenever the scroll position changes.
function createVirtualConversation(total: number, startTop = 0) {
	document.body.innerHTML = '<main><div id="thread"></div><form id="composer"></form></main>';
	const thread = document.getElementById('thread')!;
	const scrollHeight = total * TURN_HEIGHT;
	let scrollTop = startTop;

	const render = () => {
		const first = Math.max(1, Math.floor((scrollTop - OVERSCAN) / TURN_HEIGHT) + 1);
		const last = Math.min(total, Math.ceil((scrollTop + VIEWPORT + OVERSCAN) / TURN_HEIGHT));
		let html = '';
		for (let i = first; i <= last; i++) html += turnHtml(i);
		thread.innerHTML = html;
	};
	render();

	const view: ScrollView = {
		getScrollTop: () => scrollTop,
		setScrollTop: (top: number) => {
			scrollTop = Math.max(0, Math.min(top, scrollHeight - VIEWPORT));
			render();
		},
		getScrollHeight: () => scrollHeight,
		getClientHeight: () => VIEWPORT,
	};
	return { view, getScrollTop: () => scrollTop };
}

// How ChatGPT behaves on a fresh page load: only the latest turns are loaded,
// and they fill the whole scroll height. Reaching the top fetches the previous
// batch after a delay and prepends it, keeping the visible turns in place.
function createPaginatedConversation(total: number, { initial = 6, batch = 8, delayMs = 200 } = {}) {
	document.body.innerHTML = '<main><div id="thread"></div><form id="composer"></form></main>';
	const thread = document.getElementById('thread')!;
	let firstLoaded = total - initial + 1;
	let loading = false;
	const loadedHeight = () => (total - firstLoaded + 1) * TURN_HEIGHT;
	let scrollTop = loadedHeight() - VIEWPORT;

	const render = () => {
		const first = Math.max(firstLoaded, firstLoaded + Math.floor((scrollTop - OVERSCAN) / TURN_HEIGHT));
		const last = Math.min(total, firstLoaded + Math.ceil((scrollTop + VIEWPORT + OVERSCAN) / TURN_HEIGHT) - 1);
		let html = '';
		for (let i = first; i <= last; i++) html += turnHtml(i);
		thread.innerHTML = html;
	};
	const loadOlder = () => {
		if (loading || firstLoaded === 1) return;
		loading = true;
		setTimeout(() => {
			const count = Math.min(batch, firstLoaded - 1);
			firstLoaded -= count;
			scrollTop += count * TURN_HEIGHT;
			loading = false;
			render();
		}, delayMs);
	};
	render();

	const view: ScrollView = {
		getScrollTop: () => scrollTop,
		setScrollTop: (top: number) => {
			scrollTop = Math.max(0, Math.min(top, loadedHeight() - VIEWPORT));
			render();
			if (scrollTop === 0) loadOlder();
		},
		getScrollHeight: () => loadedHeight(),
		getClientHeight: () => VIEWPORT,
	};
	return { view };
}

const fast = { quietMs: 5, maxStepWaitMs: 50, topWaitMs: 1000, maxTotalMs: 10000 };

function keysOf(turns: Element[]): string[] {
	return turns.map(t => t.getAttribute('data-testid')!);
}

afterEach(() => {
	clearConversationCache();
	document.body.innerHTML = '';
});

describe('isChatGPTUrl', () => {
	it('matches ChatGPT hosts only', () => {
		expect(isChatGPTUrl('https://chatgpt.com/c/abc')).toBe(true);
		expect(isChatGPTUrl('https://chatgpt.com/g/g-p-123/c/abc')).toBe(true);
		expect(isChatGPTUrl('https://chat.openai.com/c/abc')).toBe(true);
		expect(isChatGPTUrl('https://example.com/chatgpt.com')).toBe(false);
		expect(isChatGPTUrl('not a url')).toBe(false);
	});
});

describe('TurnCollection', () => {
	const make = (i: number) => {
		const t = document.createElement('template');
		t.innerHTML = turnHtml(i);
		return t.content.firstElementChild!;
	};

	it('keeps conversation order when windows arrive bottom-up', () => {
		const collection = new TurnCollection();
		collection.capture([7, 8, 9, 10].map(make));
		collection.capture([4, 5, 6, 7].map(make));
		collection.capture([1, 2, 3, 4, 5].map(make));
		expect(keysOf(collection.toArray())).toEqual(
			Array.from({ length: 10 }, (_, i) => `conversation-turn-${i + 1}`)
		);
	});

	it('counts only new turns and fills gaps between known ones', () => {
		const collection = new TurnCollection();
		expect(collection.capture([1, 4].map(make))).toBe(2);
		expect(collection.capture([1, 2, 3, 4].map(make))).toBe(2);
		expect(keysOf(collection.toArray())).toEqual(
			[1, 2, 3, 4].map(i => `conversation-turn-${i}`)
		);
	});

	it('keeps the fuller render of a turn', () => {
		const collection = new TurnCollection();
		const partial = make(2);
		partial.querySelector('p')!.textContent = '';
		collection.capture([partial]);
		collection.capture([make(2)]);
		expect(collection.toArray()[0].textContent).toContain('Answer number 2');
	});
});

describe('collectAllTurns', () => {
	it('collects every turn of a virtualized conversation in order', async () => {
		const { view } = createVirtualConversation(60, 2500);
		expect(getMountedTurns(document).length).toBeLessThan(60);

		const collection = await collectAllTurns(document, view, fast);
		expect(keysOf(collection.toArray())).toEqual(
			Array.from({ length: 60 }, (_, i) => `conversation-turn-${i + 1}`)
		);
	});

	it('restores the original scroll position', async () => {
		const { view, getScrollTop } = createVirtualConversation(40, 1700);
		await collectAllTurns(document, view, fast);
		expect(getScrollTop()).toBe(1700);
	});

	it('waits at the top for older turns that load late', async () => {
		const { view } = createPaginatedConversation(40, { delayMs: 200 });
		expect(getMountedTurns(document).length).toBe(6);

		const collection = await collectAllTurns(document, view, fast);
		expect(keysOf(collection.toArray())).toEqual(
			Array.from({ length: 40 }, (_, i) => `conversation-turn-${i + 1}`)
		);
	});

	it('stops at the top once no older turns arrive', async () => {
		const { view } = createVirtualConversation(40, 1700);
		const started = Date.now();
		await collectAllTurns(document, view, { ...fast, topWaitMs: 300 });
		// One wait at the top, not one per step.
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it('stops when scrolling has no effect', async () => {
		createVirtualConversation(40, 1700);
		const stuck: ScrollView = {
			getScrollTop: () => 1700,
			setScrollTop: () => {},
			getScrollHeight: () => 4000,
			getClientHeight: () => VIEWPORT,
		};
		const started = Date.now();
		await collectAllTurns(document, stuck, { ...fast, maxTotalMs: 60000 });
		expect(Date.now() - started).toBeLessThan(2000);
	});
});

describe('current ChatGPT layout', () => {
	it('keys exchanges by data-turn-key and ignores the nested old markers', async () => {
		document.body.innerHTML = '<div id="thread">'
			+ [1, 2, 3].map(i => `<div><div data-turn-key="bbb-${i}"><div data-content-search-unit-key="fallback-turn-${i}:0:user">Q${i}</div></div></div>`).join('')
			+ '</div>';
		const collection = new TurnCollection();
		collection.capture(getMountedTurns(document));
		// Index-style keys get renumbered as older turns load, so they must not be used.
		document.querySelector('[data-turn-key="bbb-1"] [data-content-search-unit-key]')!.setAttribute('data-content-search-unit-key', 'fallback-turn-9:0:user');
		expect(collection.capture(getMountedTurns(document))).toBe(0);
		expect(collection.toArray().map(t => t.getAttribute('data-turn-key'))).toEqual(['bbb-1', 'bbb-2', 'bbb-3']);
	});
});

describe('isScrollable', () => {
	it('is false when the conversation fits on screen', () => {
		const { view } = createVirtualConversation(4);
		expect(isScrollable(view)).toBe(false);
	});

	it('is true when the conversation scrolls', () => {
		const { view } = createVirtualConversation(60, 2500);
		expect(isScrollable(view)).toBe(true);
	});
});

describe('getFullChatGPTConversation', () => {
	it('ignores pages that are not ChatGPT', async () => {
		const { view } = createVirtualConversation(60, 2500);
		const other = document.implementation.createHTMLDocument('Other');
		other.body.innerHTML = document.body.innerHTML;
		expect(await getFullChatGPTConversation(other, fast, view)).toBeNull();
	});

	it('produces a document Defuddle reads as the full conversation', async () => {
		const { view } = createVirtualConversation(60, 2500);
		const full = await getFullChatGPTConversation(document, fast, view);
		expect(full).not.toBeNull();
		expect(getMountedTurns(full!).length).toBe(60);
		// The live page is left as it was.
		expect(getMountedTurns(document).length).toBeLessThan(60);

		// Without the full pass Defuddle only sees the mounted fragment.
		const partial = new Defuddle(document, { url: document.URL, markdown: true }).parse();
		expect(partial.content).not.toContain('Question number 1');

		const result = new Defuddle(full!, { url: document.URL, markdown: true }).parse();
		expect(result.site).toBe('ChatGPT');
		expect(result.content).toContain('Question number 1');
		expect(result.content).toContain('Answer number 60');
		expect(result.content.indexOf('Question number 1'))
			.toBeLessThan(result.content.indexOf('Answer number 60'));
	});

	it('collects the full conversation on a fresh page load', async () => {
		// The loaded turns fill the page, so nothing looks missing until the
		// top is reached and older turns are fetched.
		const { view } = createPaginatedConversation(40);
		const full = await getFullChatGPTConversation(document, fast, view);
		expect(full).not.toBeNull();
		expect(getMountedTurns(full!).length).toBe(40);
	});

	it('reuses the previous pass instead of scrolling again', async () => {
		const { view } = createVirtualConversation(60, 2500);
		let scrolls = 0;
		const counting: ScrollView = { ...view, setScrollTop: (top) => { scrolls++; view.setScrollTop(top); } };

		await getFullChatGPTConversation(document, fast, counting);
		const firstPass = scrolls;
		expect(firstPass).toBeGreaterThan(0);

		const again = await getFullChatGPTConversation(document, fast, counting);
		expect(scrolls).toBe(firstPass);
		expect(getMountedTurns(again!).length).toBe(60);
	});
});

describe('buildConversationDocument', () => {
	it('replaces mounted turns and keeps the surrounding page', () => {
		createVirtualConversation(60, 2500);
		const turns = Array.from({ length: 60 }, (_, i) => {
			const t = document.createElement('template');
			t.innerHTML = turnHtml(i + 1);
			return t.content.firstElementChild!;
		});
		const full = buildConversationDocument(document, turns);
		expect(getMountedTurns(full).length).toBe(60);
		expect(full.getElementById('composer')).not.toBeNull();
		expect(full.getElementById('thread')!.children.length).toBe(60);
	});

	it('keeps nesting an HTML parser would rearrange', () => {
		// ChatGPT puts block badges inside paragraphs; built with DOM calls
		// that survives, but re-parsing the page as HTML would move them out.
		document.body.innerHTML = '<div id="thread"><div data-turn-key="bbb-1"><p id="claim">Claim</p></div></div>';
		const badge = document.createElement('div');
		badge.setAttribute('data-d-component', 'badge');
		document.getElementById('claim')!.append(badge);

		const full = buildConversationDocument(document, getMountedTurns(document).map(t => t.cloneNode(true) as Element));
		expect(full.querySelector('p [data-d-component="badge"]')).not.toBeNull();
	});
});
