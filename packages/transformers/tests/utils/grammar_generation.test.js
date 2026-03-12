import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import {
  AutoModelForCausalLM,
  AutoTokenizer,
} from "../../src/transformers.js";
import {
  MinLengthLogitsProcessor,
  NoBadWordsLogitsProcessor,
} from "../../src/generation/logits_process.js";
import { Tensor } from "../../src/utils/tensor.js";
import {
  init,
  MAX_TEST_EXECUTION_TIME,
  MAX_MODEL_LOAD_TIME,
  MAX_MODEL_DISPOSE_TIME,
  DEFAULT_MODEL_OPTIONS,
} from "../init.js";

init();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const grammarModulePath = path.resolve(__dirname, "../../src/generation/grammar.js");
const hasGrammarRuntime = fs.existsSync(grammarModulePath);

const describeIfGrammar = hasGrammarRuntime ? describe : describe.skip;

/** @type {any} */
let grammarModule = null;

beforeAll(async () => {
  if (hasGrammarRuntime) {
    grammarModule = await import(pathToFileURL(grammarModulePath).href);
  }
});

describeIfGrammar("GBNF parser syntax", () => {
  it("parses literals, alternation, char classes, quantifiers and nested groups", () => {
    const { parseGBNF } = grammarModule;
    const grammar = String.raw`root ::= ("a" | ("b" [0-9]+)){1,2}`;
    expect(() => parseGBNF(grammar)).not.toThrow();
  });

  it("parses token terminals (<[id]>, <token>) and negation", () => {
    const { parseGBNF } = grammarModule;
    const grammar = String.raw`root ::= <[42]> | <token_name> | [^\\n]+`;
    expect(() => parseGBNF(grammar)).not.toThrow();
  });
});

describeIfGrammar("Grammar runtime acceptance", () => {
  it("tracks grammar state transitions", () => {
    const { GrammarRuntime } = grammarModule;
    const runtime = new GrammarRuntime(String.raw`root ::= "a" "b"`);

    expect(runtime.acceptsToken("a")).toBe(true);
    runtime.pushToken("a");
    expect(runtime.acceptsToken("b")).toBe(true);
    runtime.pushToken("b");
    expect(runtime.isAccepted()).toBe(true);
  });

  it("accepts at end-of-sequence only for completed state", () => {
    const { GrammarRuntime } = grammarModule;
    const runtime = new GrammarRuntime(String.raw`root ::= "x" "y"`);
    runtime.pushToken("x");

    expect(runtime.acceptsEOS()).toBe(false);

    runtime.pushToken("y");
    expect(runtime.acceptsEOS()).toBe(true);
  });

  it("returns an explicit no-valid-token failure", () => {
    const { GrammarRuntime } = grammarModule;
    const runtime = new GrammarRuntime(String.raw`root ::= "a"`);

    runtime.pushToken("a");
    expect(() => runtime.pushToken("b")).toThrow(/no valid token/i);
  });
});

describeIfGrammar("Grammar-constrained end-to-end generation", () => {
  const model_id = "hf-internal-testing/tiny-random-LlamaForCausalLM";

  let model;
  let tokenizer;

  beforeAll(async () => {
    model = await AutoModelForCausalLM.from_pretrained(model_id, DEFAULT_MODEL_OPTIONS);
    tokenizer = await AutoTokenizer.from_pretrained(model_id);
  }, MAX_MODEL_LOAD_TIME);

  it(
    "constrains generation to JSON-like output",
    async () => {
      const inputs = tokenizer("emit json");
      const grammar = String.raw`root ::= "{" "\"ok\"" ":" ("true" | "false") "}"`;
      const output = await model.generate({
        ...inputs,
        max_new_tokens: 12,
        do_sample: false,
        grammar,
      });

      const text = tokenizer.decode(output.tolist()[0].slice(inputs.input_ids.dims.at(-1)));
      expect(text.replace(/\s+/g, "")).toMatch(/^\{\"ok\":(?:true|false)\}/);
    },
    MAX_TEST_EXECUTION_TIME,
  );

  it(
    "supports deterministic allowed-token set for finite grammar",
    async () => {
      const inputs = tokenizer("pick one");
      const grammar = String.raw`root ::= "A" | "B"`;
      const output = await model.generate({
        ...inputs,
        max_new_tokens: 1,
        do_sample: false,
        grammar,
      });

      const tokenText = tokenizer.decode([output.tolist()[0].at(-1)]);
      expect(["A", "B"]).toContain(tokenText.trim());
    },
    MAX_TEST_EXECUTION_TIME,
  );

  it(
    "tracks batched grammar state independently per row",
    async () => {
      const inputs = tokenizer(["row a", "row b"], { padding: true });
      const grammars = [
        String.raw`root ::= "yes"`,
        String.raw`root ::= "no"`,
      ];

      const output = await model.generate({
        ...inputs,
        max_new_tokens: 4,
        do_sample: false,
        grammars,
      });

      const generated = output.tolist().map((row) => tokenizer.decode(row.slice(inputs.input_ids.dims.at(-1))));
      expect(generated[0].trim()).toBe("yes");
      expect(generated[1].trim()).toBe("no");
    },
    MAX_TEST_EXECUTION_TIME,
  );

  afterAll(async () => {
    await model?.dispose();
  }, MAX_MODEL_DISPOSE_TIME);
});

describe("Regression: processor precedence semantics", () => {
  it("keeps EOS banned by bad_words_ids after min_length threshold", () => {
    const eosToken = 2;
    const ids = [[1n, 5n]];

    const logitsBeforeMinLength = new Tensor("float32", new Float32Array([0, 0, 0]), [1, 3]);
    const logitsAfterMinLength = new Tensor("float32", new Float32Array([0, 0, 0]), [1, 3]);

    const noBadWords = new NoBadWordsLogitsProcessor([[eosToken]], eosToken);
    const minLength = new MinLengthLogitsProcessor(4, eosToken);

    const processedBeforeMin = minLength._call(ids, noBadWords._call(ids, logitsBeforeMinLength));
    expect(processedBeforeMin.data[eosToken]).toBe(-Infinity);

    const longIds = [[1n, 5n, 6n, 7n, 8n]];
    const processedAfterMin = minLength._call(longIds, noBadWords._call(longIds, logitsAfterMinLength));
    expect(processedAfterMin.data[eosToken]).toBe(-Infinity);
  });

  it("min_length still suppresses EOS even when not part of bad_words_ids", () => {
    const eosToken = 2;
    const ids = [[1n, 5n]];

    const logits = new Tensor("float32", new Float32Array([0, 0, 0]), [1, 3]);

    const noBadWords = new NoBadWordsLogitsProcessor([[1]], eosToken);
    const minLength = new MinLengthLogitsProcessor(4, eosToken);

    const processed = minLength._call(ids, noBadWords._call(ids, logits));
    expect(processed.data[eosToken]).toBe(-Infinity);
  });
});
