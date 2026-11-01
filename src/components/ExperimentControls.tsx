// P006 T009 — 实验控制栏（项目书 §9.2）。
// 只派发 reducer 动作、不算公式、不碰 Worker；运行由 App 层接 Worker
// （T013：App 的派发包装在 RUN_REQUESTED/CANCEL 时驱动 workerClient）。
import type { Dispatch } from "react";
import {
  PRESET_OPTIONS,
  pmfMean,
  pmfVariance,
  type AppAction,
  type AppState,
  type PmfMode,
} from "../app/reducer";
import { stateCountForModel, type GroupId } from "../domain/types";

interface PmfDescription {
  mode: PmfMode;
  pointIndex: number;
  lowIndex: number;
  highIndex: number;
  lowWeight: number;
}

/** 从当前 PMF 推导编辑器初始形态；非点/双点分布以中点点质量作编辑起点。 */
function describePmf(pmf: ReadonlyArray<number>): PmfDescription {
  const nonzero = pmf
    .map((p, j) => ({ p, j }))
    .filter((entry) => entry.p !== 0);
  if (nonzero.length === 1) {
    return {
      mode: "point",
      pointIndex: nonzero[0]!.j,
      lowIndex: 0,
      highIndex: pmf.length - 1,
      lowWeight: 0.5,
    };
  }
  if (nonzero.length === 2) {
    const [low, high] = nonzero as [
      { p: number; j: number },
      { p: number; j: number },
    ];
    return {
      mode: "two-point",
      pointIndex: low.j,
      lowIndex: low.j,
      highIndex: high.j,
      lowWeight: low.p,
    };
  }
  let argmax = 0;
  for (let j = 1; j < pmf.length; j += 1) {
    if (pmf[j]! > pmf[argmax]!) {
      argmax = j;
    }
  }
  return {
    mode: "point",
    pointIndex: argmax,
    lowIndex: 0,
    highIndex: pmf.length - 1,
    lowWeight: 0.5,
  };
}

function PmfEditor({
  group,
  pmf,
  stateCount,
  dispatch,
}: {
  group: GroupId;
  pmf: number[];
  stateCount: number;
  dispatch: Dispatch<AppAction>;
}) {
  const desc = describePmf(pmf);
  const mean = pmfMean(pmf);
  const variance = pmfVariance(pmf);
  const setMode = (mode: PmfMode) => {
    if (mode === "point") {
      dispatch({
        type: "UPDATE_PMF",
        group,
        mode,
        pointIndex: desc.pointIndex,
      });
    } else {
      dispatch({
        type: "UPDATE_PMF",
        group,
        mode,
        lowIndex: desc.lowIndex,
        highIndex: desc.highIndex,
        lowWeight: desc.lowWeight,
      });
    }
  };
  return (
    <fieldset>
      <legend>{group} 组初始分布</legend>
      <p>
        理论均值 {mean.toFixed(4)}，理论方差 {variance.toFixed(4)}
      </p>
      <label>
        形式
        <select
          aria-label={`${group} 组分布形式`}
          value={desc.mode}
          onChange={(e) => setMode(e.target.value as PmfMode)}
        >
          <option value="point">点质量</option>
          <option value="two-point">双点混合</option>
        </select>
      </label>
      {desc.mode === "point" ? (
        <label>
          点位置 j（0 至 {stateCount - 1}）
          <input
            aria-label={`${group} 组点位置`}
            type="number"
            min={0}
            max={stateCount - 1}
            step={1}
            value={desc.pointIndex}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_PMF",
                group,
                mode: "point",
                pointIndex: Number(e.target.value),
              })
            }
          />
        </label>
      ) : (
        <>
          <label>
            低点 j
            <input
              aria-label={`${group} 组低点`}
              type="number"
              min={0}
              max={stateCount - 1}
              step={1}
              value={desc.lowIndex}
              onChange={(e) =>
                dispatch({
                  type: "UPDATE_PMF",
                  group,
                  mode: "two-point",
                  lowIndex: Number(e.target.value),
                  highIndex: desc.highIndex,
                  lowWeight: desc.lowWeight,
                })
              }
            />
          </label>
          <label>
            高点 j
            <input
              aria-label={`${group} 组高点`}
              type="number"
              min={0}
              max={stateCount - 1}
              step={1}
              value={desc.highIndex}
              onChange={(e) =>
                dispatch({
                  type: "UPDATE_PMF",
                  group,
                  mode: "two-point",
                  lowIndex: desc.lowIndex,
                  highIndex: Number(e.target.value),
                  lowWeight: desc.lowWeight,
                })
              }
            />
          </label>
          <label>
            低点权重（高点权重为 1 减此值）
            <input
              aria-label={`${group} 组低点权重`}
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={desc.lowWeight}
              onChange={(e) =>
                dispatch({
                  type: "UPDATE_PMF",
                  group,
                  mode: "two-point",
                  lowIndex: desc.lowIndex,
                  highIndex: desc.highIndex,
                  lowWeight: Number(e.target.value),
                })
              }
            />
          </label>
        </>
      )}
    </fieldset>
  );
}

export function ExperimentControls({
  state,
  dispatch,
}: {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}) {
  const { scenario, status } = state;
  const stateCount = stateCountForModel(scenario.model);
  const running = status === "RUNNING";
  // 项目书 §4：自定义两组初始均值不同时显示“非同均值实验”。
  const meanP = pmfMean(scenario.initial.P);
  const meanQ = pmfMean(scenario.initial.Q);
  const isNonEqualMean = Math.abs(meanP - meanQ) > 1e-9;
  return (
    <div className="noise-controls">
      <label>
        预置选择
        <select
          aria-label="预置选择"
          value={state.presetId}
          onChange={(e) =>
            dispatch({
              type: "SELECT_PRESET",
              presetId: e.target.value as AppState["presetId"],
            })
          }
        >
          {PRESET_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        网络
        <select
          aria-label="网络"
          value={scenario.model.id}
          onChange={(e) =>
            dispatch({
              type: "UPDATE_MODEL",
              modelId: e.target.value as "linear" | "dimer",
              totalUnits: scenario.model.totalUnits,
            })
          }
        >
          <option value="dimer">二聚 2A ⇌ B</option>
          <option value="linear">线性</option>
        </select>
      </label>
      <p>
        反应方程：{scenario.model.id === "dimer" ? "2A ⇌ B" : "线性 birth/death"}
        ；状态数 S = {stateCount}。
      </p>

      <label>
        总单位数 N（4 至 40 的 4 的倍数）
        <input
          aria-label="总单位数 N"
          type="number"
          min={4}
          max={40}
          step={4}
          value={scenario.model.totalUnits}
          onChange={(e) =>
            dispatch({
              type: "UPDATE_MODEL",
              modelId: scenario.model.id,
              totalUnits: Number(e.target.value),
            })
          }
        />
      </label>

      <label>
        正向速率 kf
        <input
          aria-label="正向速率 kf"
          type="number"
          step={0.01}
          value={scenario.model.forwardRate}
          onChange={(e) =>
            dispatch({
              type: "UPDATE_RATES",
              forwardRate: Number(e.target.value),
            })
          }
        />
      </label>

      <label>
        反向速率 kb
        <input
          aria-label="反向速率 kb"
          type="number"
          step={0.01}
          value={scenario.model.reverseRate}
          onChange={(e) =>
            dispatch({
              type: "UPDATE_RATES",
              reverseRate: Number(e.target.value),
            })
          }
        />
      </label>

      <label>
        时间范围 T（0.2 至 20）
        <input
          aria-label="时间范围 T"
          type="number"
          min={0.2}
          max={20}
          step={0.1}
          value={scenario.horizon}
          onChange={(e) =>
            dispatch({ type: "UPDATE_HORIZON", horizon: Number(e.target.value) })
          }
        />
      </label>

      <label>
        每组轨迹数 M
        <select
          aria-label="每组轨迹数 M"
          value={scenario.trajectoriesPerGroup}
          onChange={(e) =>
            dispatch({
              type: "UPDATE_TRAJECTORIES",
              trajectoriesPerGroup: Number(e.target.value),
            })
          }
        >
          {[64, 128, 256, 512, 1024, 2048, 4096].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>

      <label>
        种子（0 至 4294967295 的整数）
        <input
          aria-label="种子"
          type="number"
          min={0}
          max={4294967295}
          step={1}
          value={scenario.seed}
          onChange={(e) =>
            dispatch({ type: "UPDATE_SEED", seed: Number(e.target.value) })
          }
        />
      </label>

      <label>
        实验标题（1 至 80 字，非计算参数）
        <input
          aria-label="实验标题"
          type="text"
          value={scenario.title}
          onChange={(e) =>
            dispatch({ type: "UPDATE_TITLE", title: e.target.value })
          }
        />
      </label>

      <PmfEditor
        group="P"
        pmf={scenario.initial.P}
        stateCount={stateCount}
        dispatch={dispatch}
      />
      <PmfEditor
        group="Q"
        pmf={scenario.initial.Q}
        stateCount={stateCount}
        dispatch={dispatch}
      />

      {isNonEqualMean && (
        <p role="alert">
          非同均值实验：P 组初始均值 {meanP.toFixed(4)}，Q 组初始均值{" "}
          {meanQ.toFixed(4)}，两组初始均值不同；当前不再是同均值预置，
          默认教学结论（同均值不同走势）不适用于本实验。
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={() => dispatch({ type: "RESTORE_PRESET_PMF" })}
        >
          恢复同均值预置
        </button>
        <button
          type="button"
          disabled={running}
          onClick={() => dispatch({ type: "RUN_REQUESTED" })}
        >
          运行实验
        </button>
        <button
          type="button"
          disabled={!running}
          onClick={() => dispatch({ type: "CANCEL" })}
        >
          取消
        </button>
      </div>

      <p>
        导入与导出在下方“导入与导出”区；运行实验走真实 Worker，生产路径无
        mock 完成入口。
      </p>
    </div>
  );
}
