/**
 * @module generation/grammar/gbnf
 */

/**
 * Error thrown for malformed GBNF grammars.
 */
export class GBNFParseError extends Error {
    /**
     * @param {string} message
     * @param {number} line
     * @param {number} column
     */
    constructor(message, line, column) {
        super(`${message} (line ${line}, column ${column})`);
        this.name = 'GBNFParseError';
        this.line = line;
        this.column = column;
    }
}

class Lexer {
    /** @param {string} input */
    constructor(input) {
        this.input = input;
        this.pos = 0;
        this.line = 1;
        this.column = 1;
    }

    _peek(offset = 0) {
        return this.input[this.pos + offset];
    }

    _advance() {
        const ch = this.input[this.pos++];
        if (ch === '\n') {
            this.line += 1;
            this.column = 1;
        } else {
            this.column += 1;
        }
        return ch;
    }

    _error(message, line = this.line, column = this.column) {
        throw new GBNFParseError(message, line, column);
    }

    _skipWhitespaceAndComments() {
        while (this.pos < this.input.length) {
            const ch = this._peek();
            if (ch === '#') {
                while (this.pos < this.input.length && this._peek() !== '\n') {
                    this._advance();
                }
                continue;
            }
            if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
                this._advance();
                continue;
            }
            break;
        }
    }

    next() {
        this._skipWhitespaceAndComments();
        if (this.pos >= this.input.length) {
            return { type: 'EOF', line: this.line, column: this.column };
        }

        const startLine = this.line;
        const startColumn = this.column;
        const ch = this._peek();

        if (ch === ':' && this._peek(1) === ':' && this._peek(2) === '=') {
            this._advance();
            this._advance();
            this._advance();
            return { type: 'ASSIGN', line: startLine, column: startColumn };
        }

        if ('()|*+?{},'.includes(ch)) {
            this._advance();
            return { type: ch, line: startLine, column: startColumn };
        }

        if (ch === '!' && this._peek(1) === '<') {
            this._advance();
            const tokenForm = this._readTokenForm(startLine, startColumn);
            return { ...tokenForm, negated: true, line: startLine, column: startColumn };
        }

        if (ch === '<') {
            return this._readTokenForm(startLine, startColumn);
        }

        if (ch === '"' || ch === '\'') {
            return this._readString(startLine, startColumn);
        }

        if (ch === '[') {
            return this._readCharClass(startLine, startColumn);
        }

        if (/[0-9]/.test(ch)) {
            return this._readNumber(startLine, startColumn);
        }

        if (/[A-Za-z_]/.test(ch)) {
            return this._readIdentifier(startLine, startColumn);
        }

        this._error(`Unexpected character '${ch}'`, startLine, startColumn);
    }

    _readIdentifier(line, column) {
        let value = '';
        while (this.pos < this.input.length && /[A-Za-z0-9_\-]/.test(this._peek())) {
            value += this._advance();
        }
        return { type: 'IDENT', value, line, column };
    }

    _readNumber(line, column) {
        let value = '';
        while (this.pos < this.input.length && /[0-9]/.test(this._peek())) {
            value += this._advance();
        }
        return { type: 'NUMBER', value: Number(value), line, column };
    }

    _readString(line, column) {
        const quote = this._advance();
        let value = '';

        while (this.pos < this.input.length) {
            const ch = this._advance();
            if (ch === quote) {
                return { type: 'STRING', value, line, column };
            }
            if (ch === '\\') {
                if (this.pos >= this.input.length) {
                    this._error('Unterminated escape sequence', line, column);
                }
                const esc = this._advance();
                switch (esc) {
                    case 'n': value += '\n'; break;
                    case 'r': value += '\r'; break;
                    case 't': value += '\t'; break;
                    case '\\': value += '\\'; break;
                    case '"': value += '"'; break;
                    case '\'': value += '\''; break;
                    case 'x': {
                        const h1 = this._advance();
                        const h2 = this._advance();
                        const hex = `${h1}${h2}`;
                        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
                            this._error('Invalid hex escape sequence', this.line, this.column - 2);
                        }
                        value += String.fromCharCode(parseInt(hex, 16));
                        break;
                    }
                    case 'u': {
                        let hex = '';
                        for (let i = 0; i < 4; ++i) {
                            hex += this._advance();
                        }
                        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
                            this._error('Invalid unicode escape sequence', this.line, this.column - 4);
                        }
                        value += String.fromCharCode(parseInt(hex, 16));
                        break;
                    }
                    default:
                        this._error(`Unsupported escape sequence \\${esc}`, this.line, this.column - 1);
                }
                continue;
            }
            value += ch;
        }

        this._error('Unterminated string literal', line, column);
    }

    _readCharClass(line, column) {
        this._advance();
        let raw = '';
        let closed = false;

        while (this.pos < this.input.length) {
            const ch = this._advance();
            if (ch === ']') {
                closed = true;
                break;
            }
            if (ch === '\\') {
                if (this.pos >= this.input.length) {
                    this._error('Unterminated character class', line, column);
                }
                raw += ch;
                raw += this._advance();
            } else {
                raw += ch;
            }
        }

        if (!closed) {
            this._error('Unterminated character class', line, column);
        }

        return { type: 'CHAR_CLASS', value: raw, line, column };
    }

    _readTokenForm(line, column) {
        if (this._advance() !== '<') {
            this._error("Expected '<'", line, column);
        }

        if (this._peek() === '[') {
            this._advance();
            let digits = '';
            while (this.pos < this.input.length && /[0-9]/.test(this._peek())) {
                digits += this._advance();
            }
            if (digits.length === 0) {
                this._error('Expected token id in <[id]>', line, column);
            }
            if (this._advance() !== ']' || this._advance() !== '>') {
                this._error('Malformed token id form, expected <[id]>', line, column);
            }
            return {
                type: 'TOKEN_FORM',
                value: { form: 'id', value: Number(digits), negated: false },
                line,
                column,
            };
        }

        let text = '';
        while (this.pos < this.input.length && this._peek() !== '>') {
            text += this._advance();
        }
        if (this._advance() !== '>') {
            this._error('Unterminated token form', line, column);
        }
        if (text.length === 0) {
            this._error('Empty token form is not allowed', line, column);
        }
        return {
            type: 'TOKEN_FORM',
            value: { form: 'text', value: text, negated: false },
            line,
            column,
        };
    }
}

class Parser {
    /** @param {string} input */
    constructor(input) {
        this.lexer = new Lexer(input);
        this.current = this.lexer.next();
        this.next = this.lexer.next();
    }

    _advance() {
        const old = this.current;
        this.current = this.next;
        this.next = this.lexer.next();
        return old;
    }

    _error(message, token = this.current) {
        throw new GBNFParseError(message, token.line, token.column);
    }

    _expect(type, message) {
        if (this.current.type !== type) {
            this._error(message ?? `Expected ${type}, got ${this.current.type}`);
        }
        return this._advance();
    }

    parse() {
        const rules = new Map();
        while (this.current.type !== 'EOF') {
            const nameToken = this._expect('IDENT', 'Expected a rule name');
            this._expect('ASSIGN', `Expected '::=' after rule name '${nameToken.value}'`);
            const expression = this._parseExpression();
            if (rules.has(nameToken.value)) {
                this._error(`Duplicate rule '${nameToken.value}'`, nameToken);
            }
            rules.set(nameToken.value, expression);
        }

        if (rules.size === 0) {
            this._error('Grammar must contain at least one rule', this.current);
        }

        return { rules };
    }

    _parseExpression() {
        const alternatives = [this._parseSequence()];
        while (this.current.type === '|') {
            this._advance();
            alternatives.push(this._parseSequence());
        }
        return alternatives.length === 1 ? alternatives[0] : { type: 'alt', alternatives };
    }

    _parseSequence() {
        const elements = [];
        while (this._isPrimaryStart(this.current.type)) {
            elements.push(this._parseQuantifiedPrimary());
        }
        if (elements.length === 0) {
            return { type: 'empty' };
        }
        return elements.length === 1 ? elements[0] : { type: 'seq', elements };
    }

    _isPrimaryStart(tokenType) {
        if (tokenType === 'IDENT' && this.next.type === 'ASSIGN') {
            return false;
        }
        return tokenType === 'IDENT'
            || tokenType === 'STRING'
            || tokenType === 'CHAR_CLASS'
            || tokenType === 'TOKEN_FORM'
            || tokenType === '(';
    }

    _parseQuantifiedPrimary() {
        let node = this._parsePrimary();
        if (this.current.type === '*' || this.current.type === '+' || this.current.type === '?') {
            const quant = this._advance().type;
            switch (quant) {
                case '*': return { type: 'repeat', item: node, min: 0, max: null };
                case '+': return { type: 'repeat', item: node, min: 1, max: null };
                case '?': return { type: 'repeat', item: node, min: 0, max: 1 };
            }
        }

        if (this.current.type === '{') {
            this._advance();
            const min = this._expect('NUMBER', 'Expected number in quantifier').value;
            let max = min;
            if (this.current.type === ',') {
                this._advance();
                if (this.current.type === 'NUMBER') {
                    max = this._advance().value;
                } else {
                    max = null;
                }
            }
            this._expect('}', "Expected closing '}' in quantifier");
            if (max !== null && max < min) {
                this._error(`Invalid quantifier range {${min},${max}}: max must be >= min`);
            }
            node = { type: 'repeat', item: node, min, max };
        }

        return node;
    }

    _parsePrimary() {
        switch (this.current.type) {
            case 'IDENT':
                return { type: 'ref', name: this._advance().value };
            case 'STRING':
                return { type: 'literal', value: this._advance().value };
            case 'CHAR_CLASS':
                return { type: 'char_class', value: parseCharClass(this._advance().value) };
            case 'TOKEN_FORM': {
                const token = this._advance();
                return {
                    type: 'token',
                    form: token.value.form,
                    value: token.value.value,
                    negated: Boolean(token.negated || token.value.negated),
                };
            }
            case '(': {
                this._advance();
                const node = this._parseExpression();
                this._expect(')', "Expected ')' to close group");
                return node;
            }
            default:
                this._error(`Unexpected token '${this.current.type}'`);
        }
    }
}

function parseCharEscape(ch) {
    switch (ch) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case '\\': return '\\';
        case ']': return ']';
        case '[': return '[';
        case '-': return '-';
        default: return ch;
    }
}

/**
 * @param {string} raw
 */
function parseCharClass(raw) {
    let i = 0;
    let negated = false;
    if (raw.startsWith('^')) {
        negated = true;
        i = 1;
    }

    const parts = [];
    const readChar = () => {
        if (i >= raw.length) {
            return null;
        }
        let ch = raw[i++];
        if (ch === '\\') {
            if (i >= raw.length) {
                return null;
            }
            ch = parseCharEscape(raw[i++]);
        }
        return ch;
    };

    while (i < raw.length) {
        const first = readChar();
        if (first === null) {
            break;
        }
        if (i < raw.length && raw[i] === '-' && i + 1 < raw.length) {
            i += 1;
            const last = readChar();
            if (last === null) {
                parts.push({ type: 'char', value: first });
                parts.push({ type: 'char', value: '-' });
            } else if (first.codePointAt(0) <= last.codePointAt(0)) {
                parts.push({ type: 'range', start: first, end: last });
            } else {
                throw new Error(`Invalid range '${first}-${last}' in character class`);
            }
        } else {
            parts.push({ type: 'char', value: first });
        }
    }

    return { negated, parts };
}

function charMatches(matcher, ch) {
    if (matcher.type === 'char') {
        return matcher.value === ch;
    }
    if (matcher.type === 'class') {
        const code = ch.codePointAt(0);
        let inClass = false;
        for (const part of matcher.parts) {
            if (part.type === 'char') {
                if (part.value === ch) {
                    inClass = true;
                    break;
                }
            } else if (part.type === 'range') {
                const start = part.start.codePointAt(0);
                const end = part.end.codePointAt(0);
                if (code >= start && code <= end) {
                    inClass = true;
                    break;
                }
            }
        }
        return matcher.negated ? !inClass : inClass;
    }
    return false;
}

function tokenMatches(matcher, token) {
    const matches = matcher.form === 'id'
        ? token.id === matcher.value
        : token.text === matcher.value;
    return matcher.negated ? !matches : matches;
}

function createStateMachineBuilder() {
    const states = [];
    const newState = () => {
        const idx = states.length;
        states.push({ epsilon: [], char: [], token: [], accept: false });
        return idx;
    };

    const addEpsilon = (from, to) => {
        states[from].epsilon.push(to);
    };

    const addChar = (from, to, matcher) => {
        states[from].char.push({ to, matcher });
    };

    const addToken = (from, to, matcher) => {
        states[from].token.push({ to, matcher });
    };

    return { states, newState, addEpsilon, addChar, addToken };
}

/**
 * Parse a GBNF grammar.
 * @param {string} grammar
 * @returns {{rules: Map<string, any>}}
 */
export function parseGBNF(grammar) {
    return new Parser(grammar).parse();
}

/**
 * Compile GBNF grammar to an NFA-like automaton.
 * @param {string} grammar
 * @returns {{states: any[], startByRule: Map<string, number>, endByRule: Map<string, number>, rules: string[]}}
 */
export function compileGBNF(grammar) {
    const parsed = parseGBNF(grammar);
    const { states, newState, addEpsilon, addChar, addToken } = createStateMachineBuilder();

    const startByRule = new Map();
    const endByRule = new Map();
    const rules = [...parsed.rules.keys()];

    for (const rule of rules) {
        startByRule.set(rule, newState());
        endByRule.set(rule, newState());
    }

    const ensureRule = (name) => {
        if (!startByRule.has(name)) {
            throw new Error(`Unknown rule reference '${name}'`);
        }
    };

    const emitBetween = (node, start, end) => {
        switch (node.type) {
            case 'empty':
                addEpsilon(start, end);
                return;
            case 'literal': {
                let current = start;
                for (const ch of node.value) {
                    const next = newState();
                    addChar(current, next, { type: 'char', value: ch });
                    current = next;
                }
                addEpsilon(current, end);
                return;
            }
            case 'char_class':
                addChar(start, end, { type: 'class', ...node.value });
                return;
            case 'token':
                addToken(start, end, {
                    form: node.form,
                    value: node.value,
                    negated: node.negated,
                });
                return;
            case 'ref':
                ensureRule(node.name);
                addEpsilon(start, startByRule.get(node.name));
                addEpsilon(endByRule.get(node.name), end);
                return;
            case 'alt':
                for (const alt of node.alternatives) {
                    const branchStart = newState();
                    const branchEnd = newState();
                    addEpsilon(start, branchStart);
                    emitBetween(alt, branchStart, branchEnd);
                    addEpsilon(branchEnd, end);
                }
                return;
            case 'seq': {
                let current = start;
                for (let i = 0; i < node.elements.length; ++i) {
                    const next = i === node.elements.length - 1 ? end : newState();
                    emitBetween(node.elements[i], current, next);
                    current = next;
                }
                return;
            }
            case 'repeat': {
                if (node.max !== null) {
                    for (let repeats = node.min; repeats <= node.max; ++repeats) {
                        const branchStart = newState();
                        const branchEnd = newState();
                        addEpsilon(start, branchStart);
                        let current = branchStart;
                        for (let i = 0; i < repeats; ++i) {
                            const next = i === repeats - 1 ? branchEnd : newState();
                            emitBetween(node.item, current, next);
                            current = next;
                        }
                        if (repeats === 0) {
                            addEpsilon(branchStart, branchEnd);
                        }
                        addEpsilon(branchEnd, end);
                    }
                    return;
                }

                let current = start;
                for (let i = 0; i < node.min; ++i) {
                    const next = newState();
                    emitBetween(node.item, current, next);
                    current = next;
                }

                const loopStart = newState();
                addEpsilon(current, loopStart);
                addEpsilon(loopStart, end);
                const bodyStart = newState();
                const bodyEnd = newState();
                addEpsilon(loopStart, bodyStart);
                emitBetween(node.item, bodyStart, bodyEnd);
                addEpsilon(bodyEnd, loopStart);
                return;
            }
            default:
                throw new Error(`Unsupported AST node type '${node.type}'`);
        }
    };

    for (const [ruleName, expr] of parsed.rules) {
        emitBetween(expr, startByRule.get(ruleName), endByRule.get(ruleName));
    }

    for (const endState of endByRule.values()) {
        states[endState].accept = true;
    }

    return { states, startByRule, endByRule, rules };
}

/**
 * Runtime state machine for incremental grammar validation.
 */
export class GBNFStateMachine {
    /**
     * @param {{states: any[], startByRule: Map<string, number>, rules: string[]}} compiled
     * @param {{startRule?: string, tokenIdToText?: Map<number, string>|Record<number, string>|((id:number)=>string|undefined)}} [options]
     */
    constructor(compiled, options = {}) {
        this.compiled = compiled;
        this.startRule = options.startRule ?? compiled.rules[0];
        if (!compiled.startByRule.has(this.startRule)) {
            throw new Error(`Unknown start rule '${this.startRule}'`);
        }
        this._tokenIdToText = options.tokenIdToText;
        this.states = this._epsilonClosure([compiled.startByRule.get(this.startRule)]);
    }

    /**
     * @param {string} grammar
     * @param {{startRule?: string, tokenIdToText?: Map<number, string>|Record<number, string>|((id:number)=>string|undefined)}} [options]
     */
    static fromGrammar(grammar, options = {}) {
        return new GBNFStateMachine(compileGBNF(grammar), options);
    }

    clone() {
        const clone = new GBNFStateMachine(this.compiled, {
            startRule: this.startRule,
            tokenIdToText: this._tokenIdToText,
        });
        clone.states = new Set(this.states);
        return clone;
    }

    _resolveTokenText(id) {
        if (!this._tokenIdToText) {
            return undefined;
        }
        if (typeof this._tokenIdToText === 'function') {
            return this._tokenIdToText(id);
        }
        if (this._tokenIdToText instanceof Map) {
            return this._tokenIdToText.get(id);
        }
        return this._tokenIdToText[id];
    }

    _epsilonClosure(initialStates) {
        const stack = [...initialStates];
        const closure = new Set(initialStates);
        while (stack.length > 0) {
            const state = stack.pop();
            for (const next of this.compiled.states[state].epsilon) {
                if (!closure.has(next)) {
                    closure.add(next);
                    stack.push(next);
                }
            }
        }
        return closure;
    }

    _simulateAdvance(currentStates, token) {
        const closure = this._epsilonClosure(currentStates);
        const nextStates = new Set();

        for (const state of closure) {
            for (const edge of this.compiled.states[state].token) {
                if (tokenMatches(edge.matcher, token)) {
                    nextStates.add(edge.to);
                }
            }
        }

        if (typeof token.text === 'string') {
            let charStates = closure;
            for (const ch of token.text) {
                const step = new Set();
                for (const state of charStates) {
                    for (const edge of this.compiled.states[state].char) {
                        if (charMatches(edge.matcher, ch)) {
                            step.add(edge.to);
                        }
                    }
                }
                if (step.size === 0) {
                    charStates = null;
                    break;
                }
                charStates = this._epsilonClosure(step);
            }
            if (charStates) {
                for (const s of charStates) {
                    nextStates.add(s);
                }
            }
        }

        return this._epsilonClosure(nextStates);
    }

    /**
     * Advance with a token.
     * @param {{id?: number, text?: string}} token
     * @returns {boolean} True if token is accepted and state advanced.
     */
    advance(token) {
        const normalized = {
            id: token.id,
            text: token.text,
        };

        if (normalized.text === undefined && normalized.id !== undefined) {
            normalized.text = this._resolveTokenText(normalized.id);
        }

        const next = this._simulateAdvance(this.states, normalized);
        if (next.size === 0) {
            return false;
        }
        this.states = next;
        return true;
    }

    /**
     * Advance with token text.
     * @param {string} text
     * @returns {boolean}
     */
    advanceTokenText(text) {
        return this.advance({ text });
    }

    /**
     * Advance with token id.
     * @param {number} id
     * @param {string} [text]
     * @returns {boolean}
     */
    advanceTokenId(id, text) {
        return this.advance({ id, text });
    }

    /**
     * Whether EOS is valid at the current state.
     * @returns {boolean}
     */
    isEOSValid() {
        const closure = this._epsilonClosure(this.states);
        for (const state of closure) {
            if (this.compiled.states[state].accept) {
                return true;
            }
        }
        return false;
    }

    /**
     * Compute valid token ids from candidate tokens.
     * @param {Array<number|{id:number, text?:string}>} candidates
     * @returns {Set<number>}
     */
    getValidNextTokenIds(candidates) {
        const valid = new Set();
        for (const candidate of candidates) {
            const normalized = typeof candidate === 'number'
                ? { id: candidate, text: this._resolveTokenText(candidate) }
                : { id: candidate.id, text: candidate.text ?? this._resolveTokenText(candidate.id) };
            const next = this._simulateAdvance(this.states, normalized);
            if (next.size > 0) {
                valid.add(normalized.id);
            }
        }
        return valid;
    }
}
