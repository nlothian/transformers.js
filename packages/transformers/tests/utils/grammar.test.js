import { describe, expect, it } from "@jest/globals";

import { TokenizerGrammarBridge } from "../../src/generation/grammar.js";

class MockTokenizer {
  constructor(vocab, decoded) {
    this.vocab = vocab;
    this.decoded = decoded;
  }

  get_vocab() {
    return this.vocab;
  }

  decode_single([id]) {
    return this.decoded[id];
  }
}

describe("TokenizerGrammarBridge", () => {
  it("precomputes token id and decoded token mappings", () => {
    const tokenizer = new MockTokenizer({ A: 0, B: 1, SP: 2 }, { 0: "a", 1: "b", 2: " hello" });

    const bridge = new TokenizerGrammarBridge(tokenizer);

    expect(bridge.idToDecodedToken.get(2)).toBe(" hello");
    expect(bridge.decodedTokenToIds.get("a")).toEqual([0]);
  });

  it("resolves explicit token ids via <[id]>", () => {
    const bridge = new TokenizerGrammarBridge(new MockTokenizer({ A: 0 }, { 0: "a" }));
    expect(bridge.parseTerminal("<[0]>")).toEqual({
      kind: "token",
      tokenId: 0,
      negated: false,
      source: "<[0]>",
    });
  });

  it("resolves exact token strings via <token>", () => {
    const bridge = new TokenizerGrammarBridge(new MockTokenizer({ SPACE: 3 }, { 3: " world" }));
    expect(bridge.parseTerminal("< world>")).toEqual({
      kind: "token",
      tokenId: 3,
      negated: false,
      source: "< world>",
    });
  });

  it("supports negation for token-level terminals", () => {
    const bridge = new TokenizerGrammarBridge(new MockTokenizer({ A: 0 }, { 0: "a" }));
    const terminal = bridge.parseTerminal("!<[0]>");

    expect(terminal.negated).toBe(true);
    expect(bridge.matchesTokenTerminal(terminal, 0)).toBe(false);
    expect(bridge.matchesTokenTerminal(terminal, 2)).toBe(true);
  });

  it("leaves non-angled terminals as character-level", () => {
    const bridge = new TokenizerGrammarBridge(new MockTokenizer({ A: 0 }, { 0: "a" }));
    const terminal = bridge.parseTerminal("x");

    expect(terminal).toEqual({
      kind: "character",
      text: "x",
      negated: false,
      source: "x",
    });
    expect(bridge.matchesCharacterTerminal(terminal, "x")).toBe(true);
  });

  it("throws for multi-code-point character-level terminals", () => {
    const bridge = new TokenizerGrammarBridge(new MockTokenizer({ A: 0 }, { 0: "a" }));
    expect(() => bridge.parseTerminal("ab")).toThrow(/must use exactly one code point/);
  });

  it("preserves byte-level artifacts and leading markers in decoded token matching", () => {
    const bridge = new TokenizerGrammarBridge(new MockTokenizer({ G: 4 }, { 4: "ĠHello" }));
    expect(bridge.parseTerminal("<ĠHello>").tokenId).toBe(4);
  });

  it("throws for unresolved <token> terminals", () => {
    const bridge = new TokenizerGrammarBridge(new MockTokenizer({ A: 0 }, { 0: "a" }));
    expect(() => bridge.parseTerminal("<missing>")).toThrow(/did not resolve to any token id/);
  });

  it("throws for ambiguous <token> terminals", () => {
    const bridge = new TokenizerGrammarBridge(new MockTokenizer({ A: 0, B: 1 }, { 0: "dup", 1: "dup" }));
    expect(() => bridge.parseTerminal("<dup>")).toThrow(/ambiguous/);
  });

  it("throws when a character-level transition receives multiple code points", () => {
    const bridge = new TokenizerGrammarBridge(new MockTokenizer({ A: 0 }, { 0: "a" }));
    const terminal = bridge.parseTerminal("a");
    expect(() => bridge.matchesCharacterTerminal(terminal, "ab")).toThrow(/exactly one Unicode code point/);
  });

  it("throws for duplicate token ids in vocabulary", () => {
    expect(() => {
      new TokenizerGrammarBridge(new MockTokenizer({ A: 0, B: 0 }, { 0: "a" }));
    }).toThrow(/multiple vocabulary entries map to token id/);
  });

  it("throws for tokenizer objects missing bridge methods", () => {
    expect(() => new TokenizerGrammarBridge({ decode_single: () => "a" })).toThrow(/get_vocab\(\)/);
    expect(() => new TokenizerGrammarBridge({ get_vocab: () => ({ A: 0 }) })).toThrow(/decode_single\(\)/);
  });
});
