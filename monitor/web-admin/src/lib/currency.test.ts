// The billing field's menu is built from the browser's own tables rather than
// from a list kept by hand, so what a reader can pick -- and see -- is pinned
// here. Run it with `npm test`: node strips the types itself.
import assert from "node:assert/strict"

import { COMMON, currencyHint, currencyLabel, currencyList, searchCurrencies } from "./currency.ts"

// The three things a row shows, for the currencies the tooltip used to name by
// code alone. `£` and `JP¥` are the whole point: the mark is what makes a code
// recognisable, and it is the same mark the public page will print.
const labels = (code: string) => currencyLabel(code)
assert.deepEqual(labels("GBP"), { name: "英镑", mark: "£" }, "英镑")
assert.deepEqual(labels("CNY"), { name: "人民币", mark: "¥" }, "人民币")
assert.deepEqual(labels("JPY"), { name: "日元", mark: "JP¥" }, "日元的符号带 JP，与人民币分开")
assert.deepEqual(labels("USD"), { name: "美元", mark: "US$" }, "美元保留地区前缀")
assert.deepEqual(labels("HKD"), { name: "港元", mark: "HK$" }, "港元同样")
// A hub older than the shape check may hold anything; neither table throws.
assert.deepEqual(labels("港币"), { name: "港币", mark: "港币" }, "不是代码就照原样显示")
assert.equal(currencyHint("GBP"), "英镑", "输入框下面那行是名字")
assert.equal(currencyHint("港币"), "未知代码，照原样显示", "认不出来就说认不出来")
// 能不能折算成美元不在这里说：那是 hub 抓来的表与页面内置表的并集，面板不知道，
// 由公开页的总估价卡片自己交代
assert.equal(currencyHint("THB"), "泰铢", "没有汇率也不影响名字")

const list = currencyList()
assert.ok(list.length > 150, `浏览器能给出整份 ISO 4217，拿到 ${list.length}`)
assert.ok(list.some((c) => c.code === "GBP"), "英镑在列表里")
assert.ok(list.every((c) => c.code.length === 3 && c.name && c.mark), "每一行都有名字和符号")
// 常用在前，其余按代码字母序：第一屏是常见的那些，不是整本目录
assert.deepEqual(
  list.slice(0, COMMON.length).map((c) => c.code),
  COMMON.filter((code) => list.some((c) => c.code === code)),
  "常用货币排在前面",
)
const rest = list.slice(COMMON.length).map((c) => c.code)
assert.deepEqual(rest, [...rest].sort(), "其余按字母序，找得到也能扫得顺")

const codes = (query: string) => searchCurrencies(list, query).map((c) => c.code)
assert.deepEqual(codes("gbp"), ["GBP"], "按代码搜")
assert.deepEqual(codes(" GBP "), ["GBP"], "前后空格不算")
assert.ok(codes("英").includes("GBP"), "按中文名搜：英镑")
assert.ok(codes("£").includes("GBP"), "按符号搜：£")
assert.equal(searchCurrencies(list, "").length, list.length, "空搜索就是整份列表")
assert.deepEqual(codes("zzz"), [], "搜不到就是空的，不是整份列表")

console.log("currency 校验通过")
