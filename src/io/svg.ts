// P006 T007 — SVG 导出底层（项目书 §12.3）
//
// 导出当前分布图和均值图，各自带标题、模型参数、图例、时间及
// “合成模型”说明；不包含远程字体和外链资源（无 http 链接、
// 无 <link>、无 url()、无 @import）。这是底层生成器：它输出带
// 完整标签的成品 SVG，不是空壳；正式图表组件（T009/T012）复用
// 同一套标签要求，T007 不以空壳 SVG 冒充图表。
// 默认文件名只含 ASCII slug、时间索引和组别。

import type { RunResult } from "../domain/types";

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 默认文件名：ASCII slug + 种类 + 组别 + 时间索引，例如 noisescope-distribution-P-t042.svg。 */
export function svgFileName(
  kind: "distribution" | "means",
  group: "P" | "Q",
  timeIndex: number,
): string {
  return `noisescope-${kind}-${group}-t${String(timeIndex).padStart(3, "0")}.svg`;
}

function axisTicks(min: number, max: number, count: number): number[] {
  if (count <= 1 || max === min) {
    return [min];
  }
  const ticks: number[] = [];
  for (let i = 0; i < count; i += 1) {
    ticks.push(min + ((max - min) * i) / (count - 1));
  }
  return ticks;
}

function svgFrame(
  title: string,
  subtitle: string,
  legend: Array<{ color: string; label: string }>,
  body: string,
  xLabel: string,
  yLabel: string,
): string {
  const legendItems = legend
    .map(
      (item, i) =>
        `<rect x="470" y="${30 + i * 20}" width="14" height="14" fill="${item.color}"/><text x="490" y="${42 + i * 20}" font-size="13" fill="#222">${escapeXml(item.label)}</text>`,
    )
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="460" viewBox="0 0 720 460" role="img">`,
    `<title>${escapeXml(title)}</title>`,
    `<desc>${escapeXml(subtitle)} 合成模型</desc>`,
    `<text x="360" y="26" text-anchor="middle" font-size="17" font-weight="bold" fill="#111">${escapeXml(title)}</text>`,
    `<text x="360" y="46" text-anchor="middle" font-size="12" fill="#444">${escapeXml(subtitle)}</text>`,
    `<text x="360" y="446" text-anchor="middle" font-size="12" fill="#444">${escapeXml(xLabel)}</text>`,
    `<text x="16" y="230" text-anchor="middle" font-size="12" fill="#444" transform="rotate(-90 16 230)">${escapeXml(yLabel)}</text>`,
    legendItems,
    body,
    `<text x="360" y="430" text-anchor="middle" font-size="11" fill="#666">合成模型：仿真数据，非真实实验测量</text>`,
    `</svg>`,
  ].join("\n");
}

/**
 * 当前分布图：CME 概率（蓝条）与 SSA 样本概率（橙条）并排，
 * x 轴为状态 B，y 轴为概率；每个状态都有刻度标签。
 */
export function exportDistributionSvg(
  result: RunResult,
  group: "P" | "Q",
  timeIndex: number,
): string {
  const stateCount = result.stateCount;
  if (timeIndex < 0 || timeIndex >= result.times.length) {
    throw new RangeError("timeIndex out of range");
  }
  const time = result.times[timeIndex]!;
  const ref = result.reference[group];
  const sam = result.sample[group];
  const offset = timeIndex * stateCount;
  const probs: number[] = [];
  const sampleProbs: number[] = [];
  for (let j = 0; j < stateCount; j += 1) {
    probs.push(ref.pmf[offset + j]!);
    sampleProbs.push(
      sam.completed > 0 ? sam.counts[offset + j]! / sam.completed : 0,
    );
  }
  const maxProb = Math.max(0.05, ...probs, ...sampleProbs);
  const plotX = 70;
  const plotY = 70;
  const plotW = 380;
  const plotH = 320;
  const slot = plotW / stateCount;
  const bars: string[] = [];
  for (let j = 0; j < stateCount; j += 1) {
    const x = plotX + j * slot;
    const barW = Math.max(1, slot * 0.36);
    const h1 = (probs[j]! / maxProb) * plotH;
    const h2 = (sampleProbs[j]! / maxProb) * plotH;
    bars.push(
      `<rect x="${x.toFixed(2)}" y="${(plotY + plotH - h1).toFixed(2)}" width="${barW.toFixed(2)}" height="${h1.toFixed(2)}" fill="#2f6db3"><title>状态 ${j} CME 概率 ${probs[j]}</title></rect>`,
      `<rect x="${(x + barW).toFixed(2)}" y="${(plotY + plotH - h2).toFixed(2)}" width="${barW.toFixed(2)}" height="${h2.toFixed(2)}" fill="#e07b39"><title>状态 ${j} SSA 样本概率 ${sampleProbs[j]}</title></rect>`,
      `<text x="${(x + slot / 2).toFixed(2)}" y="${plotY + plotH + 18}" text-anchor="middle" font-size="11" fill="#333">${j}</text>`,
    );
  }
  const ticks = axisTicks(0, maxProb, 5)
    .map(
      (tick) =>
        `<text x="${plotX - 8}" y="${(plotY + plotH - (tick / maxProb) * plotH + 4).toFixed(2)}" text-anchor="end" font-size="11" fill="#333">${tick.toFixed(3)}</text>`,
    )
    .join("");
  const model = result.scenario.model;
  const subtitle =
    `组别 ${group} 时间 t=${time} 模型 ${model.id} N=${model.totalUnits} kf=${model.forwardRate} kb=${model.reverseRate} 轨迹数 ${sam.completed}`;
  return svgFrame(
    `分布图：组别 ${group} t=${time}`,
    subtitle,
    [
      { color: "#2f6db3", label: "CME 概率" },
      { color: "#e07b39", label: "SSA 样本概率" },
    ],
    `${ticks}${bars.join("")}`,
    "状态 B",
    "概率",
  );
}

/** 均值图：参考均值、闭合均值、SSA 样本均值三条折线，x 轴为时间。 */
export function exportMeansSvg(result: RunResult): string {
  const times = Array.from(result.times);
  const series: Array<{ color: string; label: string; values: number[] }> = [];
  for (const group of ["P", "Q"] as const) {
    series.push(
      { color: group === "P" ? "#2f6db3" : "#1f7a4d", label: `${group} 组参考均值`, values: Array.from(result.reference[group].meanB) },
      { color: group === "P" ? "#7aa7d6" : "#7ab89a", label: `${group} 组闭合均值`, values: Array.from(result.reference[group].closureMeanB) },
      { color: group === "P" ? "#e07b39" : "#b3541e", label: `${group} 组 SSA 样本均值`, values: Array.from(result.sample[group].meanB) },
    );
  }
  const all = series.flatMap((s) => s.values);
  const minY = Math.min(...all);
  const maxY = Math.max(...all);
  const pad = Math.max(0.5, (maxY - minY) * 0.1);
  const yMin = minY - pad;
  const yMax = maxY + pad;
  const plotX = 70;
  const plotY = 70;
  const plotW = 380;
  const plotH = 320;
  const tMax = times[times.length - 1]!;
  const point = (t: number, v: number): string =>
    `${(plotX + (tMax > 0 ? (t / tMax) * plotW : 0)).toFixed(2)},${(plotY + plotH - ((v - yMin) / (yMax - yMin)) * plotH).toFixed(2)}`;
  const polylines = series
    .map(
      (s) =>
        `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${times.map((t, i) => point(t, s.values[i]!)).join(" ")}"><title>${escapeXml(s.label)}</title></polyline>`,
    )
    .join("");
  const ticks = axisTicks(yMin, yMax, 5)
    .map(
      (tick) =>
        `<text x="${plotX - 8}" y="${(plotY + plotH - ((tick - yMin) / (yMax - yMin)) * plotH + 4).toFixed(2)}" text-anchor="end" font-size="11" fill="#333">${tick.toFixed(2)}</text>`,
    )
    .join("");
  const xTicks = [0, tMax / 2, tMax]
    .map(
      (t) =>
        `<text x="${(plotX + (tMax > 0 ? (t / tMax) * plotW : 0)).toFixed(2)}" y="${plotY + plotH + 18}" text-anchor="middle" font-size="11" fill="#333">${t}</text>`,
    )
    .join("");
  const model = result.scenario.model;
  const subtitle =
    `模型 ${model.id} N=${model.totalUnits} kf=${model.forwardRate} kb=${model.reverseRate} 轨迹数/组 ${result.scenario.trajectoriesPerGroup}`;
  return svgFrame(
    "均值图：参考、闭合与 SSA 样本均值",
    subtitle,
    series.map((s) => ({ color: s.color, label: s.label })),
    `${ticks}${xTicks}${polylines}`,
    "时间 t",
    "均值 E[B]",
  );
}
