import {
  HUMAN_INTERVENTIONS,
  SOFT_INTERVENTIONS,
  STRONG_INTERVENTIONS,
  aggregateMetrics,
  bootstrapMetrics,
  buildLabRows,
  evaluateSession,
  fitDeterministicRandomForest,
  fitEmpiricalTail,
  fitHashedNaiveBayes,
  fitNaiveBayes,
  interventionTurns,
  loadLabCorpus,
  simulateAlarms,
  splitCorpusChronologically,
  trainingExamples,
  type AggregateMetrics,
  type AlarmConfig,
  type InterventionKind,
  type LabRow,
  type LabSession,
  type RiskModel,
  type ScoredSession,
  type SessionEvaluation,
  type TailKernel,
} from "./surprise-lab.js";
import {
  SWE_CHAT_DATASET,
  SWE_CHAT_LABEL_CONFIDENCE,
  SWE_CHAT_LICENSE,
  SWE_CHAT_REVISION,
  defaultSweChatPaths,
  loadSweChatCorpus,
  type SweChatSplitName,
} from "./swe-chat-lab.js";

const args = process.argv.slice(2);
const numericFlag = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const stringFlag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
};

const REPOSITORIES = numericFlag("--repositories", 80);
const SESSIONS = numericFlag("--sessions", 4_000);
const LOCAL_PROJECTS = numericFlag("--local-projects", 30);
const LOCAL_SESSIONS = numericFlag("--local-sessions", 200);
const LOCAL_AS_OF_MS = numericFlag("--local-as-of-ms", Date.now());
const LOCAL_LEAD_WINDOW = numericFlag("--local-lead", 20);
const LEAD_WINDOW = numericFlag("--lead", 12);
const ADVISOR_TOKENS = numericFlag("--advisor-tokens", 3_000);
const SEED = numericFlag("--seed", 42);
const FINAL = args.includes("--final");
const LOCAL_TRANSFER = args.includes("--local-transfer");
const SPLIT_MODE = args.includes("--repository-split") ? "repository" as const : "chronological" as const;
const paths = defaultSweChatPaths();
const labelMode = stringFlag("--labels") ?? "soft";
const reportFrontier = args.includes("--report-frontier");
const TARGET_INTERVENTIONS: readonly InterventionKind[] = labelMode === "observed"
  ? ["steer"]
  : labelMode === "human" ? HUMAN_INTERVENTIONS
    : labelMode === "critical" ? ["rejection", "failureReport"]
      : SOFT_INTERVENTIONS;

const TARGET = {
  precisionFloor: 0.65,
  minimumBudgetNormalizedRecall: 0.7,
  rate: 8,
  maximumBreakEvenPerLedTurn: 1_500,
  minimumFires: 30,
};

const percent = (value: number): string => `${(100 * value).toFixed(1)}%`;
const metricLine = (metrics: AggregateMetrics): string =>
  `P=${percent(metrics.precision)} R=${percent(metrics.recall)} lead=${metrics.meanLead.toFixed(2)}t rate=${metrics.ratePerThousand.toFixed(2)}/1k (${metrics.matches}/${metrics.fires} fires, ${metrics.labels} labels)`;
const breakEvenPerLedTurn = (metrics: AggregateMetrics): number =>
  ADVISOR_TOKENS / Math.max(metrics.precision, 1e-9) / Math.max(metrics.meanLead, 1);

const rowsFor = (sessions: readonly LabSession[]): Map<string, readonly LabRow[]> =>
  new Map(sessions.map((session) => [session.id, buildLabRows(session)]));

const recentSessions = (sessions: readonly LabSession[]): LabSession[] => {
  const groups = new Map<string, LabSession[]>();
  for (const session of sessions) {
    const group = groups.get(session.project) ?? [];
    group.push(session);
    groups.set(session.project, group);
  }
  return [...groups.values()].flatMap((group) => {
    group.sort((left, right) => left.startedMs - right.startedMs);
    const take = Math.min(40, Math.max(10, Math.ceil(group.length / 2)));
    return group.slice(-take);
  });
};

const scoreWithModel = (
  sessions: readonly LabSession[],
  rows: ReadonlyMap<string, readonly LabRow[]>,
  model: RiskModel,
): ScoredSession[] => sessions.map((session) => {
  const sessionRows = rows.get(session.id) ?? [];
  return { session, rows: sessionRows, scores: sessionRows.map((row) => model.score(row)) };
});

const hashScore = (value: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 2 ** 32;
};

const scoreRandom = (
  sessions: readonly LabSession[],
  rows: ReadonlyMap<string, readonly LabRow[]>,
): ScoredSession[] => sessions.map((session) => {
  const sessionRows = rows.get(session.id) ?? [];
  return {
    session,
    rows: sessionRows,
    scores: sessionRows.map((row) => hashScore(`${session.id}:${row.turn}:${SEED}`)),
  };
});

interface Family {
  name: string;
  description: string[];
  model?: RiskModel;
  train: ScoredSession[];
  validation: ScoredSession[];
  test: ScoredSession[];
  control?: boolean;
}

interface Candidate {
  family: Family;
  kernel: TailKernel;
  config: AlarmConfig;
  validation: AggregateMetrics;
  evaluations: SessionEvaluation[];
  utility: number;
  satisfactory: boolean;
}

const evaluate = (
  scored: readonly ScoredSession[],
  kernel: TailKernel,
  config: AlarmConfig,
): SessionEvaluation[] => scored.map((entry) => evaluateSession(
  entry.session,
  simulateAlarms(entry, kernel, config),
  TARGET_INTERVENTIONS,
  LEAD_WINDOW,
));

const wilsonLower = (successes: number, trials: number): number => {
  if (trials === 0) return 0;
  const z = 1.96;
  const probability = successes / trials;
  const denominator = 1 + z ** 2 / trials;
  const center = probability + z ** 2 / (2 * trials);
  const margin = z * Math.sqrt((probability * (1 - probability) + z ** 2 / (4 * trials)) / trials);
  return Math.max(0, (center - margin) / denominator);
};

const candidateUtility = (metrics: AggregateMetrics): number => {
  const economics = TARGET.maximumBreakEvenPerLedTurn / Math.max(1, breakEvenPerLedTurn(metrics));
  const rateControl = TARGET.rate / Math.max(TARGET.rate, metrics.ratePerThousand);
  return (
    0.45 * wilsonLower(metrics.matches, metrics.fires) +
    0.2 * Math.min(1, budgetNormalizedRecall(metrics)) +
    0.15 * Math.min(1, metrics.meanLead / LEAD_WINDOW) +
    0.15 * Math.min(1, economics) +
    0.05 * rateControl
  );
};

const recallCeilingAtRateCap = (metrics: AggregateMetrics): number =>
  Math.min(1, TARGET.rate * metrics.turns / 1_000 / Math.max(1, metrics.labels));

const budgetNormalizedRecall = (metrics: AggregateMetrics): number =>
  metrics.recall / Math.max(1e-9, recallCeilingAtRateCap(metrics));

const satisfactory = (metrics: AggregateMetrics): boolean =>
  metrics.precision >= TARGET.precisionFloor &&
  budgetNormalizedRecall(metrics) >= TARGET.minimumBudgetNormalizedRecall &&
  metrics.ratePerThousand <= TARGET.rate &&
  breakEvenPerLedTurn(metrics) <= TARGET.maximumBreakEvenPerLedTurn &&
  metrics.fires >= TARGET.minimumFires;

const searchFamily = (family: Family): Candidate[] => {
  const kernel = fitEmpiricalTail(family.train.flatMap((entry) => [...entry.scores]));
  const candidates: Candidate[] = [];
  for (const leak of [0, 0.5, 0.8]) {
    for (const drift of [0, 0.35, 0.7, 1.2]) {
      for (const threshold of [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12]) {
        for (const cooldown of [3, 6, 10, 20]) {
          const config: AlarmConfig = {
            leak,
            drift,
            threshold,
            cooldown,
            refractory: 0,
            maxPerSession: 3,
          };
          const evaluations = evaluate(family.validation, kernel, config);
          const validation = aggregateMetrics(evaluations);
          candidates.push({
            family,
            kernel,
            config,
            validation,
            evaluations,
            utility: candidateUtility(validation),
            satisfactory: satisfactory(validation),
          });
        }
      }
    }
  }
  return candidates;
};

const splitSummary = (
  name: string,
  sessions: readonly LabSession[],
  kinds: readonly InterventionKind[] = TARGET_INTERVENTIONS,
): string => {
  const turns = sessions.reduce((sum, session) => sum + session.turns.length, 0);
  const labels = sessions.reduce(
    (sum, session) => sum + interventionTurns(session, kinds).length,
    0,
  );
  const projects = new Set(sessions.map((session) => session.project)).size;
  return `${name}: ${sessions.length} sessions, ${projects} repositories, ${turns} turns, ${labels} labels`;
};

const loadSplit = async (split: SweChatSplitName): Promise<LabSession[]> => loadSweChatCorpus({
  ...paths,
  split,
  splitMode: SPLIT_MODE,
  seed: SEED,
  repositoryLimit: REPOSITORIES,
  sessionLimit: SESSIONS,
});

const main = async (): Promise<void> => {
  console.log(`dataset: ${SWE_CHAT_DATASET}@${SWE_CHAT_REVISION} (${SWE_CHAT_LICENSE})`);
  console.log(`labels: ${labelMode}; weak soft labels carry published binary accuracy ${percent(SWE_CHAT_LABEL_CONFIDENCE)}`);
  console.log(SPLIT_MODE === "repository"
    ? `split: repository-disjoint SHA 10/16, 3/16, 3/16 (seed=${SEED}); alarm must lead by 1-${LEAD_WINDOW} decision rows`
    : `split: chronological 60/20/20 frozen at dataset revision; alarm must lead by 1-${LEAD_WINDOW} decision rows`);
  console.log("causal cutoff: intervention text and all following rows are excluded from the firing decision");

  const [train, validation] = await Promise.all([loadSplit("train"), loadSplit("validation")]);
  const test = FINAL ? await loadSplit("test") : [];
  console.log(splitSummary("train", train));
  console.log(splitSummary("validation", validation));
  if (FINAL) console.log(splitSummary("test", test));

  const trainRows = rowsFor(train);
  const validationRows = rowsFor(validation);
  const testRows = rowsFor(test);
  const examples = trainingExamples(train, trainRows, TARGET_INTERVENTIONS, LEAD_WINDOW);
  const earlyExamples = examples.map((example) => ({
    ...example,
    positive: example.targetLead !== undefined && example.targetLead >= Math.ceil(LEAD_WINDOW / 2),
  }));
  const positives = examples.filter((example) => example.positive).length;
  console.log(`training windows: ${examples.length}, positives=${positives} (${percent(positives / Math.max(1, examples.length))})`);

  const models: RiskModel[] = [
    fitNaiveBayes(examples),
    fitHashedNaiveBayes(examples),
    fitDeterministicRandomForest(examples, "swe-chat-seeded-random-forest-d4", 24, SEED, 4),
    fitDeterministicRandomForest(examples, "swe-chat-seeded-random-forest-d6", 24, SEED, 6),
    fitDeterministicRandomForest(examples, "swe-chat-seeded-random-forest-d8", 24, SEED, 8),
    fitDeterministicRandomForest(earlyExamples, "swe-chat-early-hazard-forest-d6", 24, SEED, 6),
  ];
  const families: Family[] = models.map((model) => ({
    name: model.name,
    description: model.describe(),
    model,
    train: scoreWithModel(train, trainRows, model),
    validation: scoreWithModel(validation, validationRows, model),
    test: scoreWithModel(test, testRows, model),
  }));
  families.push({
    name: "deterministic-random-control",
    description: ["FNV-1a pseudo-random score independent of trace features"],
    train: scoreRandom(train, trainRows),
    validation: scoreRandom(validation, validationRows),
    test: scoreRandom(test, testRows),
    control: true,
  });

  const validationTurns = validation.reduce((sum, session) => sum + session.turns.length, 0);
  const validationLabels = validation.reduce(
    (sum, session) => sum + interventionTurns(session, TARGET_INTERVENTIONS).length,
    0,
  );
  const structuralCeiling = Math.min(
    1,
    TARGET.rate * validationTurns / 1_000 / Math.max(1, validationLabels),
  );
  console.log(
    `structural audit: at ${TARGET.rate}/1k, one-fire/one-label recall ceiling=${percent(structuralCeiling)}; ` +
    `acceptance requires ${percent(TARGET.minimumBudgetNormalizedRecall)} of attainable recall`,
  );

  const candidates = families.flatMap(searchFamily).sort((left, right) =>
    Number(right.satisfactory) - Number(left.satisfactory) || right.utility - left.utility
  );
  if (reportFrontier) {
    const modelCandidates = candidates.filter((candidate) => !candidate.family.control);
    console.log("\nrecall-qualified economic frontier:");
    for (const recallFloor of [0.05, 0.1, 0.15, 0.2, 0.3]) {
      const candidate = modelCandidates
        .filter((entry) => entry.validation.recall >= recallFloor && entry.validation.fires >= TARGET.minimumFires)
        .sort((left, right) => breakEvenPerLedTurn(left.validation) - breakEvenPerLedTurn(right.validation))[0];
      if (candidate) console.log(`R>=${percent(recallFloor)} ${candidate.family.name}: ${metricLine(candidate.validation)} break-even=${Math.round(breakEvenPerLedTurn(candidate.validation))} λ=${candidate.config.leak} d=${candidate.config.drift} h=${candidate.config.threshold} cooldown=${candidate.config.cooldown}`);
    }
    console.log("rate-qualified recall frontier:");
    for (const rate of [4, 8, 12, 16, 24]) {
      const candidate = modelCandidates
        .filter((entry) => entry.validation.ratePerThousand <= rate && entry.validation.fires >= TARGET.minimumFires)
        .sort((left, right) => right.validation.recall - left.validation.recall || right.validation.precision - left.validation.precision)[0];
      if (candidate) console.log(`rate<=${rate}/1k ${candidate.family.name}: ${metricLine(candidate.validation)} break-even=${Math.round(breakEvenPerLedTurn(candidate.validation))} λ=${candidate.config.leak} d=${candidate.config.drift} h=${candidate.config.threshold} cooldown=${candidate.config.cooldown}`);
    }
  }

  const bestByFamily = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!bestByFamily.has(candidate.family.name)) bestByFamily.set(candidate.family.name, candidate);
  }
  console.log("\nvalidation frontier:");
  for (const candidate of bestByFamily.values()) {
    console.log(`${candidate.family.name}${candidate.family.control ? " [control]" : ""}: ${metricLine(candidate.validation)} break-even=${Math.round(breakEvenPerLedTurn(candidate.validation))} tokens/led-turn ${candidate.satisfactory ? "PASS" : "MISS"}`);
  }

  const selected = candidates.find((candidate) => candidate.satisfactory && !candidate.family.control)
    ?? candidates
      .filter((candidate) =>
        !candidate.family.control &&
        candidate.validation.ratePerThousand <= TARGET.rate &&
        breakEvenPerLedTurn(candidate.validation) <= TARGET.maximumBreakEvenPerLedTurn &&
        candidate.validation.fires >= TARGET.minimumFires
      )
      .sort((left, right) =>
        budgetNormalizedRecall(right.validation) - budgetNormalizedRecall(left.validation) ||
        right.utility - left.utility
      )[0]
    ?? candidates.filter((candidate) => !candidate.family.control)[0]
    ?? candidates[0];
  if (!selected) throw new Error("No SWE-chat candidate could be evaluated");
  console.log("\nselected on validation:");
  console.log(`${selected.family.name}: ${metricLine(selected.validation)}`);
  console.log(`alarm: λ=${selected.config.leak} d=${selected.config.drift} h=${selected.config.threshold} cooldown=${selected.config.cooldown} cap=${selected.config.maxPerSession}`);
  console.log(`break-even=${Math.round(breakEvenPerLedTurn(selected.validation))} tokens/led-turn ${selected.satisfactory ? "PASS" : "MISS"}`);
  console.log(
    `budget-normalized recall=${percent(budgetNormalizedRecall(selected.validation))} ` +
    `(target ${percent(TARGET.minimumBudgetNormalizedRecall)})`,
  );
  for (const description of selected.family.description.slice(0, 12)) console.log(`  ${description}`);

  if (LOCAL_TRANSFER && selected.family.model) {
    const localCorpus = await loadLabCorpus({
      projects: LOCAL_PROJECTS,
      sessionsPerProject: LOCAL_SESSIONS,
      minimumSessions: 10,
      settledBeforeMs: LOCAL_AS_OF_MS - 60 * 60_000,
    });
    const localSplit = splitCorpusChronologically(localCorpus);
    const localTrainRows = rowsFor(localSplit.train);
    const localValidationRows = rowsFor(localSplit.validation);
    const localCalibration = scoreWithModel(localSplit.train, localTrainRows, selected.family.model);
    const localValidation = scoreWithModel(localSplit.validation, localValidationRows, selected.family.model);
    const localKernel = fitEmpiricalTail(localCalibration.flatMap((entry) => [...entry.scores]));
    const localEvaluations = localValidation.map((entry) => evaluateSession(
      entry.session,
      simulateAlarms(entry, localKernel, selected.config),
      STRONG_INTERVENTIONS,
      LEAD_WINDOW,
    ));
    const localMetrics = aggregateMetrics(localEvaluations);
    console.log("\nlocal pi transfer (external model, local calibration; local test remains sealed):");
    console.log(`local corpus as-of: ${new Date(LOCAL_AS_OF_MS).toISOString()}`);
    console.log(splitSummary("local train/calibration", localSplit.train, STRONG_INTERVENTIONS));
    console.log(splitSummary("local validation", localSplit.validation, STRONG_INTERVENTIONS));
    console.log(`${metricLine(localMetrics)} break-even=${Math.round(breakEvenPerLedTurn(localMetrics))} tokens/led-turn`);

    const recentLocal = recentSessions(localSplit.train);
    const recentRows = rowsFor(recentLocal);
    const localExamples = trainingExamples(
      recentLocal,
      recentRows,
      STRONG_INTERVENTIONS,
      LOCAL_LEAD_WINDOW,
    );
    const localModel = fitDeterministicRandomForest(
      localExamples,
      "local-adaptation-forest",
      16,
      SEED,
      6,
    );
    const externalRecentCalibration = scoreWithModel(recentLocal, recentRows, selected.family.model);
    const localOnlyCalibration = scoreWithModel(recentLocal, recentRows, localModel);
    const localOnlyValidation = scoreWithModel(localSplit.validation, localValidationRows, localModel);

    for (const externalWeight of [0, 0.15, 0.3, 0.5]) {
      const blend = (
        external: readonly ScoredSession[],
        local: readonly ScoredSession[],
      ): ScoredSession[] => external.map((entry, index) => ({
        ...entry,
        scores: entry.scores.map((score, turn) =>
          externalWeight * score + (1 - externalWeight) * (local[index]?.scores[turn] ?? 0)
        ),
      }));
      const calibrated = blend(externalRecentCalibration, localOnlyCalibration);
      const validation = blend(localValidation, localOnlyValidation);
      const kernel = fitEmpiricalTail(calibrated.flatMap((entry) => [...entry.scores]));
      const evaluations = validation.map((entry) => evaluateSession(
        entry.session,
        simulateAlarms(entry, kernel, {
          leak: 0,
          drift: 0.35,
          threshold: 3,
          cooldown: 6,
          refractory: 0,
          maxPerSession: 5,
        }),
        STRONG_INTERVENTIONS,
        LOCAL_LEAD_WINDOW,
      ));
      const metrics = aggregateMetrics(evaluations);
      console.log(`local adaptation external-weight=${externalWeight.toFixed(2)}: ${metricLine(metrics)} break-even=${Math.round(breakEvenPerLedTurn(metrics))}`);
    }
  }

  if (FINAL) {
    const evaluations = evaluate(selected.family.test, selected.kernel, selected.config);
    const metrics = aggregateMetrics(evaluations);
    const interval = bootstrapMetrics(evaluations, 1_000, SEED);
    console.log("\nsealed chronological test:");
    console.log(metricLine(metrics));
    console.log(`budget-normalized recall=${percent(budgetNormalizedRecall(metrics))}`);
    console.log(`break-even=${Math.round(breakEvenPerLedTurn(metrics))} tokens/led-turn ${satisfactory(metrics) ? "PASS" : "MISS"}`);
    console.log(`95% session bootstrap: P=${percent(interval.precision[0])}-${percent(interval.precision[1])} R=${percent(interval.recall[0])}-${percent(interval.recall[1])} rate=${interval.ratePerThousand[0].toFixed(2)}-${interval.ratePerThousand[1].toFixed(2)}/1k`);
  } else {
    console.log("\ntest remains sealed; rerun with --final only after accepting the validation policy");
  }
};

await main();
