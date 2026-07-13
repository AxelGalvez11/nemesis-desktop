const COURSE_COMMENT = /^\s*<!--\s*course:\s*.+?\s*-->\s*$/i;
function parsedLines(markdown) {
    const lines = [];
    let headingDepth = 0;
    for (const rawLine of markdown.split(/\r?\n/)) {
        if (COURSE_COMMENT.test(rawLine)) {
            continue;
        }
        const heading = rawLine.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (heading) {
            headingDepth = heading[1].length - 1;
            lines.push({ depth: headingDepth, isBullet: false, text: heading[2].trim() });
            continue;
        }
        const bullet = rawLine.match(/^(\s*)[-*+]\s+(.+?)\s*$/);
        if (bullet) {
            const indentation = bullet[1].replace(/\t/g, '  ').length;
            lines.push({ depth: headingDepth + 1 + Math.floor(indentation / 2), isBullet: true, text: bullet[2].trim() });
        }
    }
    return lines;
}
/** Split the optional bullet explanation on the first exact `: ` delimiter. */
function splitBullet(text) {
    const separator = text.indexOf(': ');
    if (separator < 0) {
        return { topic: text };
    }
    const topic = text.slice(0, separator).trim();
    const note = text.slice(separator + 2).trim();
    return topic && note ? { note, topic } : { topic: text };
}
function stableId(value) {
    // FNV-1a keeps ids deterministic without pulling browser or crypto APIs into the
    // parser. Stable ids let a separately persisted arrangement survive reloads.
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `mindmap-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
function createNode(line, occurrences) {
    const content = line.isBullet ? splitBullet(line.text) : { topic: line.text };
    const identity = `${line.isBullet ? 'bullet' : 'heading'}:${content.topic}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return {
        children: [],
        expanded: true,
        id: stableId(`${identity}:${occurrence}`),
        note: content.note,
        topic: content.topic
    };
}
/** Convert the agent-authored heading/bullet outline into mind-elixir node data.
 *
 * The first outline item is the required mind-elixir root. Later items attach to the
 * nearest shallower heading/bullet. If a file has no usable outline, its file title is
 * used as a harmless root so the viewer can still open.
 */
export function parseMindmapMarkdown(markdown, fallbackTopic = 'Mind map') {
    const lines = parsedLines(markdown);
    const occurrences = new Map();
    if (!lines.length) {
        return createNode({ depth: 0, isBullet: false, text: fallbackTopic }, occurrences);
    }
    const root = createNode(lines[0], occurrences);
    const stack = [{ depth: lines[0].depth, node: root }];
    for (const line of lines.slice(1)) {
        const node = createNode(line, occurrences);
        while (stack.length > 1 && stack[stack.length - 1].depth >= line.depth) {
            stack.pop();
        }
        const parent = stack[stack.length - 1].depth < line.depth ? stack[stack.length - 1].node : root;
        parent.children ??= [];
        parent.children.push(node);
        stack.push({ depth: line.depth, node });
    }
    return root;
}
