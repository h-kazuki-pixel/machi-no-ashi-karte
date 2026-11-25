// 画面（push.js の APP_VERSION）と sw.js（SW_VERSION）の版の番号が同じか
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const v = (f, name) => fs.readFileSync(new URL(f, import.meta.url), "utf8").match(new RegExp(`${name} = "([^"]+)"`))[1];
test("APP_VERSION と SW_VERSION が同じ", () => assert.equal(v("../js/push.js", "APP_VERSION"), v("../sw.js", "SW_VERSION")));
