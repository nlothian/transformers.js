/**
 * @file Token-aware grammar helpers.
 *
 * GBNF terminals are interpreted as Unicode code points. This bridge keeps token-level terminals
 * (`<...>`) opt-in so character-level rules and tokenizer-level rules do not silently overlap.
 *
 * Unicode and normalization policy:
 * - Character-level terminals are matched on JavaScript strings (Unicode code points via `for...of`).
 * - Token-level terminals are matched against `tokenizer.decode_single([id], { clean_up_tokenization_spaces: false })`.
 * - No additional normalization (NFC/NFD/NFKC/...) is applied by default; decoded token strings are used verbatim.
 * - This preserves leading spaces and byte-level artifacts that are part of a tokenizer's native decoding behavior.
 */

/**
 * @typedef {Object} TokenTerminal
 * @property {'token'} kind
 * @property {number} tokenId
 * @property {boolean} negated
 * @property {string} source
 */

/**
 * @typedef {Object} CharacterTerminal
 * @property {'character'} kind
 * @property {string} text
 * @property {boolean} negated
 * @property {string} source
 */

/**
 * @typedef {TokenTerminal | CharacterTerminal} GrammarTerminal
 */

const TOKEN_TERMINAL_RE = /^(!)?<([\s\S]+)>$/;
const TOKEN_ID_TERMINAL_RE = /^\[([0-9]+)\]$/;

/**
 * Resolve and validate grammar terminals against a tokenizer.
 */
export class TokenizerGrammarBridge {
    /** @type {Map<number, string>} */
    idToDecodedToken = new Map();

    /** @type {Map<string, number[]>} */
    decodedTokenToIds = new Map();

    /**
     * @param {{
     *   get_vocab: () => Record<string, number>,
     *   decode_single: (token_ids: number[], options?: { skip_special_tokens?: boolean, clean_up_tokenization_spaces?: boolean | null }) => string,
     * }} tokenizer
     */
    constructor(tokenizer) {
        if (typeof tokenizer?.get_vocab !== 'function') {
            throw new Error('TokenizerGrammarBridge requires a tokenizer with a get_vocab() method.');
        }
        if (typeof tokenizer?.decode_single !== 'function') {
            throw new Error('TokenizerGrammarBridge requires a tokenizer with a decode_single() method.');
        }

        this.tokenizer = tokenizer;
        this.#buildTokenMaps();
    }

    #buildTokenMaps() {
        const vocab = this.tokenizer.get_vocab();

        for (const [token, rawId] of Object.entries(vocab)) {
            if (!Number.isInteger(rawId) || rawId < 0) {
                throw new Error(`Unsupported tokenizer vocabulary entry: token "${token}" has invalid id ${rawId}.`);
            }

            if (this.idToDecodedToken.has(rawId)) {
                const previous = this.idToDecodedToken.get(rawId);
                throw new Error(
                    `Unsupported tokenizer behavior: multiple vocabulary entries map to token id ${rawId} (previous decoded value "${previous}").`,
                );
            }

            const decoded = this.tokenizer.decode_single([rawId], {
                skip_special_tokens: false,
                clean_up_tokenization_spaces: false,
            });

            if (typeof decoded !== 'string') {
                throw new Error(`Unsupported tokenizer behavior: decoding token id ${rawId} did not return a string.`);
            }

            this.idToDecodedToken.set(rawId, decoded);

            const matching = this.decodedTokenToIds.get(decoded);
            if (matching) {
                matching.push(rawId);
            } else {
                this.decodedTokenToIds.set(decoded, [rawId]);
            }
        }
    }

    /**
     * Parse a terminal and resolve token-level forms:
     * - `<[id]>`: explicit token id
     * - `<token>`: decoded token string which must resolve to exactly one id
     * - `!<...>`: negation for token-level terminal
     *
     * Any non-`<...>` string is treated as a character-level terminal.
     *
     * @param {string} terminal
     * @returns {GrammarTerminal}
     */
    parseTerminal(terminal) {
        const tokenMatch = terminal.match(TOKEN_TERMINAL_RE);
        if (!tokenMatch) {
            const codePoints = Array.from(terminal);
            if (codePoints.length !== 1) {
                throw new Error(
                    `Character-level terminal "${terminal}" contains ${codePoints.length} Unicode code points. ` +
                        'Character-level transitions must use exactly one code point.',
                );
            }

            return {
                kind: 'character',
                text: terminal,
                negated: false,
                source: terminal,
            };
        }

        const [, negationFlag, body] = tokenMatch;
        const negated = Boolean(negationFlag);
        const idMatch = body.match(TOKEN_ID_TERMINAL_RE);

        if (idMatch) {
            const tokenId = Number(idMatch[1]);
            if (!this.idToDecodedToken.has(tokenId)) {
                throw new Error(`Unknown token id in grammar terminal "${terminal}": ${tokenId}.`);
            }

            return {
                kind: 'token',
                tokenId,
                negated,
                source: terminal,
            };
        }

        const matches = this.decodedTokenToIds.get(body);

        if (!matches || matches.length === 0) {
            throw new Error(
                `Token terminal "${terminal}" did not resolve to any token id for the active tokenizer. ` +
                    'Use <[id]> to reference token ids directly.',
            );
        }

        if (matches.length > 1) {
            throw new Error(
                `Token terminal "${terminal}" is ambiguous for the active tokenizer and resolves to multiple ids: ` +
                    `${matches.join(', ')}. Use <[id]> to disambiguate.`,
            );
        }

        return {
            kind: 'token',
            tokenId: matches[0],
            negated,
            source: terminal,
        };
    }

    /**
     * Validate whether a token id satisfies a token-level terminal.
     * @param {TokenTerminal} terminal
     * @param {number} tokenId
     */
    matchesTokenTerminal(terminal, tokenId) {
        if (terminal.kind !== 'token') {
            throw new Error(`Expected a token-level terminal, got ${terminal.kind}.`);
        }

        const isMatch = terminal.tokenId === tokenId;
        return terminal.negated ? !isMatch : isMatch;
    }

    /**
     * Validate whether a code point satisfies a character-level terminal.
     * `candidate` should contain exactly one Unicode code point.
     *
     * @param {CharacterTerminal} terminal
     * @param {string} candidate
     */
    matchesCharacterTerminal(terminal, candidate) {
        if (terminal.kind !== 'character') {
            throw new Error(`Expected a character-level terminal, got ${terminal.kind}.`);
        }

        const points = Array.from(candidate);
        if (points.length !== 1) {
            throw new Error(
                `Character-level transitions require exactly one Unicode code point, but received ${points.length}.`,
            );
        }

        const isMatch = terminal.text === candidate;
        return terminal.negated ? !isMatch : isMatch;
    }
}
