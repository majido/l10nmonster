export function consolidateDecodedParts(parts, flags, convertToString) {
    const consolidatedParts = [];
    let accumulatedString = '';
    for (const part of parts) {
        if (part.t === 's' || typeof part === 'string') {
            accumulatedString += typeof part === 'string' ? part : part.v;
            part.flag && (flags[part.flag] = true);
        } else {
            if (accumulatedString.length > 0) {
                consolidatedParts.push(convertToString ? accumulatedString : { t: 's', v: accumulatedString });
                accumulatedString = '';
            }
            consolidatedParts.push(part);
        }
    }
    if (accumulatedString.length > 0) {
        consolidatedParts.push(convertToString ? accumulatedString : { t: 's', v: accumulatedString });
    }
    return consolidatedParts;
}

export function decodeNormalizedString(nstr, decoderList, flags = {}) {
    if (decoderList) {
        for (const decoder of decoderList) {
            nstr = consolidateDecodedParts(decoder(nstr), flags);
        }
    }
    return consolidateDecodedParts(nstr, flags, true);
}

export function getNormalizedString(str, decoderList, flags = {}) {
    return decodeNormalizedString([ { t: 's', v: str } ], decoderList, flags);
}

export function partEncoderMaker(textEncoders, codeEncoders) {
    return function encodePart(part, flags) {
        const encoders = typeof part === 'string' ? textEncoders : codeEncoders;
        const str = typeof part === 'string' ? part : part.v;
        if (encoders) {
            return encoders.reduce((s, encoder) => encoder(s, flags), str);
        } else {
            return str;
        }
    };
}

export function flattenNormalizedSourceToOrdinal(nsrc) {
    return nsrc.map(e => (typeof e === 'string' ? e : `{{${e.t}}}`)).join('');
}

export function flattenNormalizedSourceV1(nsrc) {
    const normalizedStr = [],
        phMap = {};
    let phIdx = 0;
    for (const part of nsrc) {
        if (typeof part === 'string') {
            normalizedStr.push(part);
        } else {
            phIdx++;
            const phPrefix = phIdx < 26 ? String.fromCharCode(96 + phIdx) : `z${phIdx}`;
            const mangledPh = `${phPrefix}_${part.t}_${(part.v?.match(/[0-9A-Za-z_]+/) || [''])[0]}`;
            normalizedStr.push(`{{${mangledPh}}}`);
            phMap[mangledPh] = {
                ...part,
                v1: mangledPh,
            };
        }
    }
    return [ normalizedStr.join(''), phMap ];
}

export function extractNormalizedPartsV1(str, phMap) {
    const normalizedParts = [];
    let pos = 0;
    for (const match of str.matchAll(/{{(?<ph>(?<phIdx>[a-y]|z\d+)_(?<t>x|bx|ex)_(?<phName>[0-9A-Za-z_]*))}}/g)) {
        if (match.index > pos) {
            normalizedParts.push(match.input.substring(pos, match.index));
        }
        normalizedParts.push(phMap[match.groups.ph] && {
            ...phMap[match.groups.ph],
            v1: match.groups.ph,
        });
        pos = match.index + match[0].length;
    }
    if (pos < str.length) {
        normalizedParts.push(str.substring(pos, str.length));
    }
    // TODO: validate actual vs. expected placeholders (name/types/number)
    return normalizedParts;
}

export function flattenNormalizedSourceToXmlV1(nsrc) {
    const normalizedStr = [],
        phMap = {};
    let phIdx = 0,
        nestingLevel = 0,
        openTagShorthand = [];
    for (const part of nsrc) {
        if (typeof part === 'string') {
            normalizedStr.push(part.replaceAll('<', '&lt;'));
        } else {
            phIdx++;
            const phPrefix = phIdx < 26 ? String.fromCharCode(96 + phIdx) : `z${phIdx}`;
            const mangledPh = `${phPrefix}_${part.t}_${(part.v.match(/[0-9A-Za-z_]+/) || [''])[0]}`;
            let phShorthand = `x${phIdx}`;
            if (part.t === 'x' || (part.t === 'ex' && nestingLevel === 0)) { // if we get a close tag before an open one, treat it like a single tag
                if (part.s) { // if we have a ph sample, we emit it as a child text node
                    normalizedStr.push(`<${phShorthand}>${part.s}</${phShorthand}>`);
                } else {
                    normalizedStr.push(`<${phShorthand} />`);
                }
            } else if (part.t === 'bx') {
                normalizedStr.push(`<${phShorthand}>`);
                openTagShorthand[nestingLevel] = phShorthand;
                nestingLevel++;
                phShorthand = `b${phShorthand}`;
            } else if (part.t === 'ex') {
                nestingLevel--;
                phShorthand = openTagShorthand[nestingLevel];
                normalizedStr.push(`</${phShorthand}>`);
                phShorthand = `e${phShorthand}`;
            }
            phMap[phShorthand] = {
                ...part,
                v1: mangledPh,
            };
        }
    }
    return [ normalizedStr.join(''), phMap ];
}

const cleanXMLEntities = str => str.replaceAll('&lt;', '<').replaceAll('&amp;', '&').replaceAll('&nbsp;', '\xa0')
export function extractNormalizedPartsFromXmlV1(str, phMap) {
    const normalizedParts = [];
    let pos = 0;
    for (const match of str.matchAll(/<(?<x>x\d+) \/>|<(?<bx>x\d+)>|<\/(?<ex>x\d+)>/g)) {
        const phSample = phMap[match.groups.ex];
        if (match.index > pos) {
            if (phSample) {  // if we have a ph sample, skip the text node and only preserve the leading space if there
                match.input.charAt(pos) === ' ' && normalizedParts.push(' ');
            } else {
                normalizedParts.push(cleanXMLEntities(match.input.substring(pos, match.index)));
            }
        }
        !phMap[match.groups.bx] && // if we have a ph sample, skip the open tag
            normalizedParts.push(phSample ??
                phMap[match.groups.x] ??
                phMap[match.groups.bx && `b${match.groups.bx}`] ??
                phMap[match.groups.ex && `e${match.groups.ex}`]);
        // if we have a ph sample preserve the trailing space if there
        match.index > pos && phSample && match.input.charAt(match.index - 1) === ' ' && normalizedParts.push(' ');
        pos = match.index + match[0].length;
    }
    if (pos < str.length) {
        normalizedParts.push(cleanXMLEntities(str.substring(pos, str.length)));
    }
    return normalizedParts;
}

const minifyV1PH = v1ph => v1ph && v1ph.split('_').slice(0, -1).join('_');

export function phMatcherMaker(nsrc) {
    const phMap = flattenNormalizedSourceV1(nsrc)[1];
    const v1PhMap = Object.fromEntries(Object.entries(phMap).map(([k, v]) => [minifyV1PH(k), v]));
    const valueMap = Object.fromEntries(Object.values(v1PhMap).map(e => [ e.v, true ]));
    return function matchPH(part) {
        return v1PhMap[minifyV1PH(part.v1)] ?? (valueMap[part.v] && part);
    }
}

export function sourceAndTargetAreCompatible(nsrc, ntgt) {
    if (Boolean(nsrc) && Boolean(ntgt)) {
        !Array.isArray(nsrc) && (nsrc = [ nsrc ]);
        !Array.isArray(ntgt) && (ntgt = [ ntgt ]);
        const phMatcher = phMatcherMaker(nsrc);
        if (!phMatcher) {
            return false;
        }
        for (const part of ntgt) {
            if (typeof part === 'object') {
                if (phMatcher(part) === undefined) {
                    return false;
                }
            }
        }
        // the loop above may pass, yet the target may have fewer placeholder, so we check the number of ph is the same
        return Object.keys(nsrc.filter(e => typeof e === 'object')).length === Object.keys(ntgt.filter(e => typeof e === 'object')).length;
    }
    return false;
}

function flattenNormalizedSourceToMiniV1(nsrc) {
    return nsrc.map(e => (typeof e === 'string' ? e : `{{${e.v1 ? minifyV1PH(e.v1) : e.v}}}`)).join('');
}

export function normalizedStringsAreEqual(s1, s2) {
    const f1 = Array.isArray(s1) ? flattenNormalizedSourceToMiniV1(s1) : s1;
    const f2 = Array.isArray(s2) ? flattenNormalizedSourceToMiniV1(s2) : s2;
    return f1 === f2;
}

export function getTUMaps(tus) {
    const contentMap = {};
    const tuMeta = {};
    const phNotes = {};
    for (const tu of tus) {
        const guid = tu.guid;
        if (tu.nsrc) {
            const [normalizedStr, phMap ] = flattenNormalizedSourceV1(tu.nsrc);
            contentMap[guid] = normalizedStr;
            if (Object.keys(phMap).length > 0) {
                tuMeta[guid] = { phMap, nsrc: tu.nsrc };
                const sourcePhNotes = tu?.notes?.ph ?? {};
                phNotes[guid] = Object.entries(phMap)
                    .reduce((p, c, i) => `${p}\n  ${String.fromCodePoint(9312 + i)}  ${c[0]} → ${c[1].v}${c[1].s === undefined ? '' : ` → ${c[1].s}`}${sourcePhNotes[c[1].v]?.desc ? `   (${sourcePhNotes[c[1].v].desc})` : ''}`, '\n ph:')
                    .replaceAll('<', 'ᐸ')
                    .replaceAll('>', 'ᐳ'); // hack until they stop stripping html
            }
            if (tu.ntgt) {
                // eslint-disable-next-line no-unused-vars
                const [normalizedStr, phMap ] = flattenNormalizedSourceV1(tu.ntgt);
                phNotes[guid] += `\n current translation: ${normalizedStr}`;
            }
        } else {
            contentMap[guid] = tu.src;
            tuMeta[guid] = { src: tu.src };
            if (tu.tgt) {
                phNotes[guid] = `\n current translation: ${tu.tgt}`;
            }
        }
    }
    return { contentMap, tuMeta, phNotes };
}

function nstrHasV1Missing(nstr) {
    for (const part of nstr) {
        if (typeof part === 'object' && !part.v1) {
            return true;
        }
    }
    return false;
}

export function cleanupTU(tu, whitelist) {
    const cleanTU = Object.fromEntries(Object.entries(tu).filter(e => whitelist.has(e[0])));
    // if we have the normalized source, and the target doesn't have v1 placeholders, we can try to build them
    // TODO: remove (for performance reasons) when v1 are strongly enforced
    if (cleanTU.nsrc && cleanTU.ntgt && nstrHasV1Missing(cleanTU.ntgt)) {
        const lookup = {};
        const sourcePhMap = flattenNormalizedSourceV1(cleanTU.nsrc)[1];
        Object.values(sourcePhMap).forEach(part => (lookup[part.v] ??= []).push(part.v1));
        for (const part of cleanTU.ntgt) {
            if (typeof part === 'object') {
                // any kind of mismatch should be fatal because src/tgt should be in sync
                part.v1 = lookup[part.v].shift(); // there's no guarantee we pick the right one, so we go FIFO
            }
        }
    }
    return cleanTU;
}

const notesAnnotationRegex = /(?:PH\((?<phName>[^)|]+)(?:\|(?<phSample>[^)|]+))(?:\|(?<phDesc>[^)|]+))?\)|MAXWIDTH\((?<maxWidth>\d+)\)|SCREENSHOT\((?<screenshot>[^)]+)\))/g;
export function extractStructuredNotes(notes) {
    const sNotes = {};
    const cleanDesc = notes.replaceAll(notesAnnotationRegex, (match, phName, phSample, phDesc, maxWidth, screenshot) => {
            if (maxWidth !== undefined) {
                sNotes.maxWidth = Number(maxWidth);
            } else if (phName !== undefined) {
                sNotes.ph = sNotes.ph ?? {};
                sNotes.ph[phName] = {
                    sample: phSample,
                };
                phDesc && (sNotes.ph[phName].desc = phDesc);
            } else if (screenshot !== undefined) {
                sNotes.screenshot = screenshot;
            }
            return '';
        });
    sNotes.desc = cleanDesc;
    return sNotes;
}
