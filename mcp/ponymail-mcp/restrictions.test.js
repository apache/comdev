// Tests for restrictions.js. Run with: npm test
//
// restrictions.js captures env vars at module load, so each test that
// exercises a different configuration spawns a child node process via
// runInChild() with the desired environment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, "restrictions.js");

// Run a snippet of JS in a child process with the given env, importing
// restrictions.js fresh. Returns the parsed JSON the snippet prints.
function runInChild(env, snippet) {
  const code = `
    const r = await import(${JSON.stringify(modulePath)});
    const out = (() => { ${snippet} })();
    process.stdout.write(JSON.stringify(out));
  `;
  const res = spawnSync("node", ["--input-type=module", "-e", code], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`child failed: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

test("default restrictions block private@ on any domain", () => {
  const out = runInChild({}, `
    return {
      kafka: r.restrictionFor("private", "kafka.apache.org"),
      iceberg: r.restrictionFor("private", "iceberg.apache.org"),
      foundation: r.restrictionFor("private", "apache.org"),
    };
  `);
  assert.equal(out.kafka, "private@");
  assert.equal(out.iceberg, "private@");
  assert.equal(out.foundation, "private@");
});

test("default restrictions block security@ on any domain", () => {
  const out = runInChild({}, `
    return r.restrictionFor("security", "airflow.apache.org");
  `);
  assert.equal(out, "security@");
});

test("default restrictions block ASF foundation lists by exact match", () => {
  const out = runInChild({}, `
    return {
      board: r.restrictionFor("board", "apache.org"),
      members: r.restrictionFor("members", "apache.org"),
      boardOnOther: r.restrictionFor("board", "kafka.apache.org"),
    };
  `);
  assert.equal(out.board, "board@apache.org");
  assert.equal(out.members, "members@apache.org");
  assert.equal(out.boardOnOther, null, "exact-match pattern must not leak across domains");
});

test("default restrictions allow ordinary lists", () => {
  const out = runInChild({}, `
    return {
      dev: r.restrictionFor("dev", "iceberg.apache.org"),
      user: r.restrictionFor("user", "kafka.apache.org"),
    };
  `);
  assert.equal(out.dev, null);
  assert.equal(out.user, null);
});

test("default restrictions match case-insensitively against input", () => {
  const out = runInChild({}, `
    return {
      upperList: r.restrictionFor("PRIVATE", "Kafka.Apache.ORG"),
      mixedDomain: r.restrictionFor("Board", "APACHE.ORG"),
    };
  `);
  assert.equal(out.upperList, "private@");
  assert.equal(out.mixedDomain, "board@apache.org");
});

test("PONYMAIL_RESTRICTED_LISTS=none clears all pattern blocks", () => {
  const out = runInChild({ PONYMAIL_RESTRICTED_LISTS: "none" }, `
    return {
      patterns: r.listRestrictions(),
      privateKafka: r.restrictionFor("private", "kafka.apache.org"),
    };
  `);
  assert.deepEqual(out.patterns, []);
  assert.equal(out.privateKafka, null);
});

test('PONYMAIL_RESTRICTED_LISTS="" also clears pattern blocks', () => {
  const out = runInChild({ PONYMAIL_RESTRICTED_LISTS: "" }, `
    return r.listRestrictions();
  `);
  assert.deepEqual(out, []);
});

test("PONYMAIL_RESTRICTED_LISTS replaces defaults entirely", () => {
  const out = runInChild({ PONYMAIL_RESTRICTED_LISTS: "foo@,@bar.org" }, `
    return {
      patterns: r.listRestrictions(),
      foo: r.restrictionFor("foo", "anywhere.example"),
      anyAtBar: r.restrictionFor("dev", "bar.org"),
      privateNoLongerBlocked: r.restrictionFor("private", "kafka.apache.org"),
    };
  `);
  assert.deepEqual(out.patterns, ["foo@", "@bar.org"]);
  assert.equal(out.foo, "foo@");
  assert.equal(out.anyAtBar, "@bar.org");
  assert.equal(out.privateNoLongerBlocked, null);
});

test("allowlist bypasses pattern block", () => {
  const out = runInChild(
    { PONYMAIL_ALLOWED_LISTS: "private@iceberg.apache.org" },
    `
      return {
        iceberg: r.restrictionFor("private", "iceberg.apache.org"),
        kafka: r.restrictionFor("private", "kafka.apache.org"),
      };
    `,
  );
  assert.equal(out.iceberg, null, "allow-listed list must not be blocked");
  assert.equal(out.kafka, "private@", "non-allow-listed list must still be blocked");
});

test("allowlist domain pattern bypasses block for whole domain", () => {
  const out = runInChild(
    { PONYMAIL_ALLOWED_LISTS: "@iceberg.apache.org" },
    `
      return {
        privateIce: r.restrictionFor("private", "iceberg.apache.org"),
        securityIce: r.restrictionFor("security", "iceberg.apache.org"),
        privateKafka: r.restrictionFor("private", "kafka.apache.org"),
      };
    `,
  );
  assert.equal(out.privateIce, null);
  assert.equal(out.securityIce, null);
  assert.equal(out.privateKafka, "private@");
});

test("allowlist accepts mixed-case input and matches case-insensitively", () => {
  const out = runInChild(
    { PONYMAIL_ALLOWED_LISTS: "Private@Iceberg.Apache.ORG" },
    `
      return r.restrictionFor("private", "iceberg.apache.org");
    `,
  );
  assert.equal(out, null);
});

test("isPrivateBlocked: blocks on truthy private flag values", () => {
  const out = runInChild({}, `
    return {
      booleanTrue: r.isPrivateBlocked("foo", "bar.apache.org", true),
      numberOne: r.isPrivateBlocked("foo", "bar.apache.org", 1),
      stringTrue: r.isPrivateBlocked("foo", "bar.apache.org", "true"),
      stringOne: r.isPrivateBlocked("foo", "bar.apache.org", "1"),
      stringYes: r.isPrivateBlocked("foo", "bar.apache.org", "yes"),
      stringTRUE: r.isPrivateBlocked("foo", "bar.apache.org", "TRUE"),
    };
  `);
  assert.equal(out.booleanTrue, true);
  assert.equal(out.numberOne, true);
  assert.equal(out.stringTrue, true);
  assert.equal(out.stringOne, true);
  assert.equal(out.stringYes, true);
  assert.equal(out.stringTRUE, true);
});

test("isPrivateBlocked: does not block on falsy values", () => {
  const out = runInChild({}, `
    return {
      booleanFalse: r.isPrivateBlocked("foo", "bar.apache.org", false),
      numberZero: r.isPrivateBlocked("foo", "bar.apache.org", 0),
      stringFalse: r.isPrivateBlocked("foo", "bar.apache.org", "false"),
      stringEmpty: r.isPrivateBlocked("foo", "bar.apache.org", ""),
      undef: r.isPrivateBlocked("foo", "bar.apache.org", undefined),
      nullVal: r.isPrivateBlocked("foo", "bar.apache.org", null),
    };
  `);
  assert.equal(out.booleanFalse, false);
  assert.equal(out.numberZero, false);
  assert.equal(out.stringFalse, false);
  assert.equal(out.stringEmpty, false);
  assert.equal(out.undef, false);
  assert.equal(out.nullVal, false);
});

test("isPrivateBlocked: allowlist bypasses the block even when private", () => {
  const out = runInChild(
    { PONYMAIL_ALLOWED_LISTS: "security@airflow.apache.org" },
    `
      return {
        allowed: r.isPrivateBlocked("security", "airflow.apache.org", true),
        notAllowed: r.isPrivateBlocked("security", "kafka.apache.org", true),
      };
    `,
  );
  assert.equal(out.allowed, false);
  assert.equal(out.notAllowed, true);
});

test("pattern grammar: prefix@ vs @domain vs prefix@domain", () => {
  const out = runInChild(
    {
      PONYMAIL_RESTRICTED_LISTS: "alpha@,@beta.org,gamma@delta.org",
    },
    `
      return {
        alphaAnywhere: r.restrictionFor("alpha", "any.example"),
        anyAtBeta: r.restrictionFor("dev", "beta.org"),
        gammaAtDelta: r.restrictionFor("gamma", "delta.org"),
        gammaElsewhere: r.restrictionFor("gamma", "epsilon.org"),
        otherAtDelta: r.restrictionFor("dev", "delta.org"),
      };
    `,
  );
  assert.equal(out.alphaAnywhere, "alpha@");
  assert.equal(out.anyAtBeta, "@beta.org");
  assert.equal(out.gammaAtDelta, "gamma@delta.org");
  assert.equal(out.gammaElsewhere, null);
  assert.equal(out.otherAtDelta, null);
});

test("restrictionForAddress handles list@domain strings", () => {
  const out = runInChild({}, `
    return {
      privateAddr: r.restrictionForAddress("private@kafka.apache.org"),
      devAddr: r.restrictionForAddress("dev@kafka.apache.org"),
      malformed: r.restrictionForAddress("not-an-address"),
      empty: r.restrictionForAddress(""),
      nullArg: r.restrictionForAddress(null),
    };
  `);
  assert.equal(out.privateAddr, "private@");
  assert.equal(out.devAddr, null);
  assert.equal(out.malformed, null);
  assert.equal(out.empty, null);
  assert.equal(out.nullArg, null);
});

test("isRestricted is a thin boolean wrapper around restrictionFor", () => {
  const out = runInChild({}, `
    return {
      privateKafka: r.isRestricted("private", "kafka.apache.org"),
      devKafka: r.isRestricted("dev", "kafka.apache.org"),
    };
  `);
  assert.equal(out.privateKafka, true);
  assert.equal(out.devKafka, false);
});

test("restrictionError mentions the address and the matched pattern", () => {
  const out = runInChild({}, `
    return r.restrictionError("private", "kafka.apache.org", "private@");
  `);
  assert.match(out, /private@kafka\.apache\.org/);
  assert.match(out, /"private@"/);
  assert.match(out, /PONYMAIL_RESTRICTED_LISTS|PONYMAIL_ALLOWED_LISTS/);
});

test("parsePatternList handles whitespace, blanks, and mixed case", () => {
  const out = runInChild(
    { PONYMAIL_ALLOWED_LISTS: "  Foo@,  ,@BAR.org , baz@QUUX.com  " },
    `
      return r.listAllowed();
    `,
  );
  assert.deepEqual(out, ["foo@", "@bar.org", "baz@quux.com"]);
});

test("listRestrictions and listAllowed return copies, not the live arrays", () => {
  const out = runInChild({}, `
    const a = r.listRestrictions();
    const b = r.listRestrictions();
    a.push("mutated");
    return { mutatedSeen: b.includes("mutated") };
  `);
  assert.equal(out.mutatedSeen, false);
});

test("restrictionFor and isPrivateBlocked tolerate falsy list/domain", () => {
  const out = runInChild({}, `
    return {
      noList: r.restrictionFor(null, "kafka.apache.org"),
      noDomain: r.restrictionFor("private", null),
      both: r.restrictionFor(null, null),
      privateNoList: r.isPrivateBlocked(null, null, true),
    };
  `);
  assert.equal(out.noList, null);
  assert.equal(out.noDomain, null);
  assert.equal(out.both, null);
  // No list/domain → can't check allowlist, but private flag is still true,
  // so block. (Defence-in-depth: better to over-block than under-block.)
  assert.equal(out.privateNoList, true);
});
