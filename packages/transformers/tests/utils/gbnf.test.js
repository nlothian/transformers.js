import {
    GBNFParseError,
    parseGBNF,
    compileGBNF,
    GBNFStateMachine,
} from '../../src/generation/grammar/gbnf.js';

describe('GBNF parser', () => {
    it('parses rules with alternatives, groups, char classes and quantifiers', () => {
        const grammar = `
            # Comment
            root ::= item+ ("," item)?
            item ::= [a-zA-Z_][a-zA-Z0-9_]{0,3} | "\"quoted\""
        `;

        const parsed = parseGBNF(grammar);
        expect(parsed.rules.has('root')).toBe(true);
        expect(parsed.rules.has('item')).toBe(true);
    });

    it('supports token forms and negated token forms', () => {
        const grammar = 'root ::= <token> <[42]> !<bad>';
        const parsed = parseGBNF(grammar);
        expect(parsed.rules.has('root')).toBe(true);
    });

    it('throws deterministic parse errors with line and column', () => {
        const grammar = 'root ::= "unterminated';
        expect(() => parseGBNF(grammar)).toThrow(GBNFParseError);
        expect(() => parseGBNF(grammar)).toThrow(/line 1, column 10/);
    });

    it('throws on malformed quantifier ranges', () => {
        expect(() => parseGBNF('root ::= "a"{3,1}')).toThrow(/max must be >= min/);
    });
});

describe('GBNF runtime state machine', () => {
    it('supports incremental text acceptance and eos checks', () => {
        const machine = GBNFStateMachine.fromGrammar('root ::= "ab"');
        expect(machine.isEOSValid()).toBe(false);
        expect(machine.advanceTokenText('a')).toBe(true);
        expect(machine.isEOSValid()).toBe(false);

        const machine2 = GBNFStateMachine.fromGrammar('root ::= "ab"');
        expect(machine2.advanceTokenText('ab')).toBe(true);
        expect(machine2.isEOSValid()).toBe(true);
    });

    it('supports token ids and valid-next-token-id filtering', () => {
        const grammar = 'root ::= <[1]> <ok> !<[5]>';
        const compiled = compileGBNF(grammar);
        const machine = new GBNFStateMachine(compiled, {
            tokenIdToText: {
                2: 'ok',
                5: 'x',
                7: 'y',
            },
        });

        expect(machine.getValidNextTokenIds([1, 2, 7])).toEqual(new Set([1]));
        expect(machine.advanceTokenId(1)).toBe(true);

        expect(machine.getValidNextTokenIds([2, 5])).toEqual(new Set([2]));
        expect(machine.advanceTokenId(2)).toBe(true);

        expect(machine.getValidNextTokenIds([5, 7])).toEqual(new Set([7]));
        expect(machine.advanceTokenId(7)).toBe(true);
        expect(machine.isEOSValid()).toBe(true);
    });

    it('throws on unknown rule references at compile time', () => {
        expect(() => compileGBNF('root ::= missing')).toThrow(/Unknown rule reference/);
    });
});
