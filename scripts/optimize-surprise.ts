// Deterministic advisor-signal laboratory. Models train only on chronological
// training sessions; equation and alarm settings are selected on validation.
// Pass --final only after the validation target is accepted to open the
// untouched chronological test split.
//
// Usage: npx tsx scripts/optimize-surprise.ts [--projects 10] [--sessions 200] [--final]

import os from "node:os";
import path from "node:path";
import {
  EXPANDED_INTERVENTIONS,
  STRONG_INTERVENTIONS,
  aggregateMetrics,
  bootstrapMetrics,
  buildLabRows,
  evaluateSession,
  fitConjunctionForest,
  fitDeterministicRandomForest,
  fitEmpiricalTail,
  fitHashedNaiveBayes,
  fitNaiveBayes,
  fitStumpForest,
  interventionTurns,
  loadLabCorpus,
  metricsByProject,
  productionScores,
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
  type TrainingExample,
} from "./surprise-lab.js";

const args = process.argv.slice(2);
const numericFlag = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const PROJECTS = numericFlag("--projects", 30);
const SESSIONS = numericFlag("--sessions", 200);
const LEAD_WINDOW = numericFlag("--lead", 20);
const FINAL = args.includes("--final");
const POST_HOLDOUT = args.includes("--post-holdout");
const ADVISOR_TOKENS = numericFlag("--advisor-tokens", 3_000);
const SETTLED_MINUTES = numericFlag("--settled-minutes", 60);
const AS_OF_MS = numericFlag("--as-of-ms", Date.now());
const CORPUS_CUTOFF_MS = AS_OF_MS - SETTLED_MINUTES * 60_000;
const labelIndex = args.indexOf("--labels");
const LABEL_MODE = labelIndex >= 0 ? args[labelIndex + 1] ?? "strong" : "strong";
const TARGET_INTERVENTIONS: readonly InterventionKind[] = LABEL_MODE === "steer"
  ? ["steer"]
  : LABEL_MODE === "abort" ? ["abort"] : STRONG_INTERVENTIONS;
// Economic acceptance for an automatic advisor. Cost depends on the joint
// precision/lead product: C_advisor / (precision · meanLead). Independent
// precision and lead minima reject economically better tradeoffs, so the hard
// constraint is break-even directly. A 25% precision floor still prevents a
// wide horizon from laundering chance matches into an apparently cheap policy.
const TARGET = {
  precisionFloor: 0.25,
  recall: 0.15,
  rate: 8,
  maximumBreakEvenPerLedTurn: 1_500,
  minimumFires: 30,
};

const home = os.homedir();
const displayPath = (value: string): string => {
  if (value === home) return "~";
  return value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
};
const percent = (value: number): string => `${(100 * value).toFixed(1)}%`;
const metricLine = (metrics: AggregateMetrics): string =>
  `P=${percent(metrics.precision)} R=${percent(metrics.recall)} lead=${metrics.meanLead.toFixed(2)}t rate=${metrics.ratePerThousand.toFixed(2)}/1k (${metrics.matches}/${metrics.fires} fires, ${metrics.labels} labels)`;

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

interface Family {
  name: string;
  description: string[];
  train: ScoredSession[];
  validation: ScoredSession[];
  test: ScoredSession[];
  control?: boolean;
}

const scoredProduction = (
  sessions: readonly LabSession[],
  rows: ReadonlyMap<string, readonly LabRow[]>,
): ScoredSession[] => sessions.map((session) => ({
  session,
  rows: rows.get(session.id) ?? [],
  scores: productionScores(session),
}));

const scoreWithProjectModels = (
  sessions: readonly LabSession[],
  rows: ReadonlyMap<string, readonly LabRow[]>,
  models: ReadonlyMap<string, RiskModel>,
  fallback: RiskModel,
): ScoredSession[] => sessions.map((session) => {
  const sessionRows = rows.get(session.id) ?? [];
  const model = models.get(session.project) ?? fallback;
  return { session, rows: sessionRows, scores: sessionRows.map((row) => model.score(row)) };
});

const projectModels = (
  examples: readonly TrainingExample[],
  fit: (group: readonly TrainingExample[], name: string) => RiskModel,
): Map<string, RiskModel> => {
  const groups = new Map<string, TrainingExample[]>();
  for (const example of examples) {
    const group = groups.get(example.project) ?? [];
    group.push(example);
    groups.set(example.project, group);
  }
  const models = new Map<string, RiskModel>();
  for (const [project, group] of groups) {
    const positives = group.filter((example) => example.positive).length;
    if (group.length >= 500 && positives >= 30) models.set(project, fit(group, project));
  }
  return models;
};

const scoredRandom = (
  sessions: readonly LabSession[],
  rows: ReadonlyMap<string, readonly LabRow[]>,
): ScoredSession[] => sessions.map((session) => {
  const sessionRows = rows.get(session.id) ?? [];
  return {
    session,
    rows: sessionRows,
    scores: sessionRows.map((row) => hashScore(`${session.id}:${row.turn}`)),
  };
});

const entropyRule: RiskModel = {
  name: "entropy-cusum",
  score: (row) => {
    const f = row.features;
    return (
      1.5 * Math.log1p(f.errors) +
      0.8 * Math.log1p(f.retries) +
      0.45 * Math.log1p(f.revisits) +
      0.65 * Math.log1p(f.errorMomentum) +
      0.45 * Math.log1p(f.retryMomentum) +
      0.6 * f.callConcentration * f.toolBurst +
      0.25 * f.toolConcentration * f.toolBurst +
      0.08 * Math.log1p(f.runLength) +
      0.12 * f.failureStreak +
      0.18 * f.responseDurationLog +
      0.16 * f.toolDurationLog +
      0.2 * f.terminalMomentum +
      0.15 * f.interventionMomentum
    );
  },
  describe: () => [
    "log-count trouble + decayed momentum",
    "exact-call and tool-name entropy deficits gated by tool burst",
    "small run-length and failure-streak priors",
  ],
};

const evaluateConfig = (
  scored: readonly ScoredSession[],
  kernel: TailKernel,
  config: AlarmConfig,
  kinds: readonly InterventionKind[] = TARGET_INTERVENTIONS,
): SessionEvaluation[] => scored.map((entry) => evaluateSession(
  entry.session,
  simulateAlarms(entry, kernel, config),
  kinds,
  LEAD_WINDOW,
));

const fBeta = (precision: number, recall: number, beta = 0.5): number => {
  const betaSquared = beta ** 2;
  const denominator = betaSquared * precision + recall;
  return denominator > 0 ? (1 + betaSquared) * precision * recall / denominator : 0;
};

const wilsonLower = (successes: number, trials: number): number => {
  if (trials === 0) return 0;
  const z = 1.96;
  const p = successes / trials;
  const denominator = 1 + z ** 2 / trials;
  const center = p + z ** 2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * trials)) / trials);
  return Math.max(0, (center - margin) / denominator);
};

interface Candidate {
  family: Family;
  kernel: TailKernel;
  config: AlarmConfig;
  validation: AggregateMetrics;
  evaluations: SessionEvaluation[];
  utility: number;
  satisfactory: boolean;
}

const candidateUtility = (metrics: AggregateMetrics): number =>
  0.55 * wilsonLower(metrics.matches, metrics.fires) +
  0.3 * metrics.recall +
  0.1 * fBeta(metrics.precision, metrics.recall) +
  0.05 * Math.min(1, metrics.meanLead / LEAD_WINDOW);

const breakEvenPerLedTurn = (metrics: AggregateMetrics): number =>
  ADVISOR_TOKENS / Math.max(metrics.precision, 1e-9) / Math.max(metrics.meanLead, 1);

const isSatisfactory = (metrics: AggregateMetrics): boolean =>
  metrics.precision >= TARGET.precisionFloor &&
  metrics.recall >= TARGET.recall &&
  metrics.ratePerThousand <= TARGET.rate &&
  breakEvenPerLedTurn(metrics) <= TARGET.maximumBreakEvenPerLedTurn &&
  metrics.fires >= TARGET.minimumFires;

const searchFamily = (family: Family): Candidate[] => {
  const kernel = fitEmpiricalTail(family.train.flatMap((entry) => [...entry.scores]));
  const candidates: Candidate[] = [];
  for (const leak of [0, 0.5, 0.8, 1]) {
    for (const drift of [0, 0.35, 0.7, 1.2]) {
      for (const threshold of [1, 1.5, 2, 2.5, 3, 4, 5]) {
        for (const cooldown of [3, 6, 10]) {
          for (const refractory of [0, 3, 6]) {
            const config: AlarmConfig = {
              leak,
              drift,
              threshold,
              cooldown,
              refractory,
              maxPerSession: 5,
            };
            const evaluations = evaluateConfig(family.validation, kernel, config);
            const validation = aggregateMetrics(evaluations);
            if (validation.ratePerThousand > TARGET.rate || validation.matches < 3) continue;
            candidates.push({
              family,
              kernel,
              config,
              validation,
              evaluations,
              utility: candidateUtility(validation),
              satisfactory: isSatisfactory(validation),
            });
          }
        }
      }
    }
  }
  return candidates.sort((left, right) =>
    Number(right.satisfactory) - Number(left.satisfactory) ||
    right.utility - left.utility ||
    right.validation.precision - left.validation.precision ||
    right.validation.recall - left.validation.recall,
  );
};

const splitSummary = (name: string, sessions: readonly LabSession[]): string => {
  const turns = sessions.reduce((sum, session) => sum + session.turns.length, 0);
  const labels = sessions.reduce(
    (sum, session) => sum + interventionTurns(session, TARGET_INTERVENTIONS).length,
    0,
  );
  return `${name}: ${sessions.length} sessions, ${turns} turns, ${labels} strong intervention episodes`;
};

const main = async (): Promise<void> => {
  const sessions = await loadLabCorpus({
    projects: PROJECTS,
    sessionsPerProject: SESSIONS,
    minimumSessions: 10,
    settledBeforeMs: CORPUS_CUTOFF_MS,
  });
  const split = splitCorpusChronologically(sessions);
  const trainRows = rowsFor(split.train);
  const validationRows = rowsFor(split.validation);
  const testRows = rowsFor(split.test);
  const examples = trainingExamples(split.train, trainRows, TARGET_INTERVENTIONS, LEAD_WINDOW);
  const steerExamples = trainingExamples(split.train, trainRows, ["steer"], LEAD_WINDOW);
  const abortExamples = trainingExamples(split.train, trainRows, ["abort"], LEAD_WINDOW);
  const recentTrain = recentSessions(split.train);
  const recentExamples = trainingExamples(recentTrain, trainRows, TARGET_INTERVENTIONS, LEAD_WINDOW);
  const recentAbortExamples = trainingExamples(recentTrain, trainRows, ["abort"], LEAD_WINDOW);
  const bayes = fitNaiveBayes(examples);
  const lexical = fitHashedNaiveBayes(examples);
  const hybrid: RiskModel = {
    name: "numeric-lexical-hybrid",
    score: (row) => bayes.score(row) + lexical.score(row),
    describe: () => [...bayes.describe().slice(0, 6), ...lexical.describe().slice(0, 6)],
  };
  const forest = fitStumpForest(examples);
  const conjunction = fitConjunctionForest(examples);
  const randomForest = fitDeterministicRandomForest(examples);
  const steerConjunction = fitConjunctionForest(steerExamples, "steer-conjunction-forest");
  const abortConjunction = fitConjunctionForest(abortExamples, "abort-conjunction-forest");
  const recentBayes = fitNaiveBayes(recentExamples);
  const recentForest = fitDeterministicRandomForest(recentExamples, "recent-seeded-random-forest");
  const recentAbortConjunction = fitConjunctionForest(
    recentAbortExamples,
    "recent-abort-conjunction-forest",
  );
  const recentFamilies: Family[] = [recentBayes, recentForest, recentAbortConjunction].map((model) => ({
    name: `recent:${model.name}`,
    description: [`trained on ${recentTrain.length} recent prior-epoch sessions`, ...model.describe()],
    train: scoreWithModel(recentTrain, trainRows, model),
    validation: scoreWithModel(split.validation, validationRows, model),
    test: scoreWithModel(split.test, testRows, model),
  }));
  const localBayes = projectModels(examples, (group) => fitNaiveBayes(group));
  const localLexical = projectModels(examples, (group) => fitHashedNaiveBayes(group));
  const localHybrid = projectModels(examples, (group, project) => {
    const numeric = fitNaiveBayes(group);
    const words = fitHashedNaiveBayes(group);
    return {
      name: `project-hybrid:${project}`,
      score: (row) => numeric.score(row) + words.score(row),
      describe: () => [],
    };
  });
  const hierarchicalFamilies: Family[] = [
    { name: "project-naive-bayes", models: localBayes, fallback: bayes },
    { name: "project-hashed-hazard", models: localLexical, fallback: lexical },
    { name: "project-numeric-lexical", models: localHybrid, fallback: hybrid },
  ].map(({ name, models, fallback }) => ({
    name,
    description: [`${models.size} project-local models; global fallback for sparse histories`],
    train: scoreWithProjectModels(split.train, trainRows, models, fallback),
    validation: scoreWithProjectModels(split.validation, validationRows, models, fallback),
    test: scoreWithProjectModels(split.test, testRows, models, fallback),
  }));

  const modelFamilies = [
    bayes,
    lexical,
    hybrid,
    forest,
    conjunction,
    randomForest,
    steerConjunction,
    abortConjunction,
    entropyRule,
  ].map((model): Family => ({
    name: model.name,
    description: model.describe(),
    train: scoreWithModel(split.train, trainRows, model),
    validation: scoreWithModel(split.validation, validationRows, model),
    test: scoreWithModel(split.test, testRows, model),
  }));
  const families: Family[] = [
    {
      name: "production-score",
      description: ["current EWMA-z weighted score, causally re-evaluated"],
      train: scoredProduction(split.train, trainRows),
      validation: scoredProduction(split.validation, validationRows),
      test: scoredProduction(split.test, testRows),
    },
    ...modelFamilies,
    ...hierarchicalFamilies,
    ...recentFamilies,
    {
      name: "random-control",
      description: ["deterministic hash noise; multiple-comparison control"],
      train: scoredRandom(split.train, trainRows),
      validation: scoredRandom(split.validation, validationRows),
      test: scoredRandom(split.test, testRows),
      control: true,
    },
  ];

  console.log("# Causal advisor-signal search");
  console.log(`settled corpus cutoff: ${new Date(CORPUS_CUTOFF_MS).toISOString()} (${SETTLED_MINUTES}m quiet)`);
  console.log(`labels: ${LABEL_MODE}, clustered within 1 turn; alarm must lead by 1-${LEAD_WINDOW} turns; one-to-one matching`);
  console.log(splitSummary("train", split.train));
  console.log(splitSummary("validation", split.validation));
  console.log(splitSummary("test (sealed unless --final)", split.test));
  console.log(`economic target: P>=${percent(TARGET.precisionFloor)} R>=${percent(TARGET.recall)} break-even<=${TARGET.maximumBreakEvenPerLedTurn} tokens/led-turn rate<=${TARGET.rate}/1k fires>=${TARGET.minimumFires}`);

  const searched = families.map((family) => ({ family, candidates: searchFamily(family) }));
  console.log("\n## Validation frontier");
  for (const result of searched) {
    const best = result.candidates[0];
    if (!best) {
      console.log(`${result.family.name}: no candidate retained`);
      continue;
    }
    console.log(`${result.family.name}: ${metricLine(best.validation)}${best.satisfactory ? " SATISFIED" : ""}`);
    console.log(`  ${JSON.stringify(best.config)}`);
  }

  const eligible = searched
    .filter((result) => !result.family.control)
    .flatMap((result) => result.candidates)
    .sort((left, right) =>
      Number(right.satisfactory) - Number(left.satisfactory) ||
      right.utility - left.utility,
    );
  const selected = eligible[0];
  if (!selected) throw new Error("No signal candidate survived the rate and match constraints");
  console.log("\n## Selected without opening test");
  console.log(`${selected.family.name}: ${metricLine(selected.validation)}${selected.satisfactory ? " SATISFIED" : " NOT YET SATISFACTORY"}`);
  console.log(`config: ${JSON.stringify(selected.config)}`);
  const validationBreakEven = breakEvenPerLedTurn(selected.validation);
  console.log(`token break-even: ${validationBreakEven.toFixed(0)} smaller-model tokens avoided per led turn for a ${ADVISOR_TOKENS}-token advisor call`);
  for (const line of selected.family.description.slice(0, 12)) console.log(`  ${line}`);
  const expandedValidation = aggregateMetrics(
    evaluateConfig(selected.family.validation, selected.kernel, selected.config, EXPANDED_INTERVENTIONS),
  );
  console.log(`expanded-label diagnostic: ${metricLine(expandedValidation)}`);

  if (!FINAL) {
    console.log("\nTest split remains sealed. Refine on validation, then rerun once with --final.");
    return;
  }

  let finalScored = selected.family.test;
  let finalKernel = selected.kernel;
  let refitNote = "selected training split retained";
  if (selected.family.name === "recent:recent-seeded-random-forest") {
    const priorSessions = [...split.train, ...split.validation];
    const priorRows = new Map<string, readonly LabRow[]>([...trainRows, ...validationRows]);
    const recentPrior = recentSessions(priorSessions);
    const finalExamples = trainingExamples(
      recentPrior,
      priorRows,
      TARGET_INTERVENTIONS,
      LEAD_WINDOW,
    );
    const finalModel = fitDeterministicRandomForest(
      finalExamples,
      "recent-seeded-random-forest",
    );
    const calibration = scoreWithModel(recentPrior, priorRows, finalModel);
    finalKernel = fitEmpiricalTail(calibration.flatMap((entry) => [...entry.scores]));
    finalScored = scoreWithModel(split.test, testRows, finalModel);
    refitNote = `refit selected architecture on ${recentPrior.length} recent train+validation sessions`;
  }
  console.log(refitNote);
  const testEvaluations = evaluateConfig(finalScored, finalKernel, selected.config);
  const test = aggregateMetrics(testEvaluations);
  const interval = bootstrapMetrics(testEvaluations);
  console.log(POST_HOLDOUT
    ? "\n## Post-holdout sensitivity check"
    : "\n## Untouched chronological test");
  console.log(`${selected.family.name}: ${metricLine(test)}${isSatisfactory(test) ? " SATISFIED" : " FAILED TARGET"}`);
  const testBreakEven = breakEvenPerLedTurn(test);
  console.log(`token break-even: ${testBreakEven.toFixed(0)} smaller-model tokens avoided per led turn`);
  console.log(`95% session bootstrap: P=[${percent(interval.precision[0])}, ${percent(interval.precision[1])}] R=[${percent(interval.recall[0])}, ${percent(interval.recall[1])}] rate=[${interval.ratePerThousand[0].toFixed(2)}, ${interval.ratePerThousand[1].toFixed(2)}]/1k`);
  const cwdByProject = new Map(split.test.map((session) => [session.project, session.cwd]));
  for (const [project, metrics] of metricsByProject(testEvaluations)) {
    console.log(`  ${displayPath(cwdByProject.get(project) ?? project)}: ${metricLine(metrics)}`);
  }
};

await main();
