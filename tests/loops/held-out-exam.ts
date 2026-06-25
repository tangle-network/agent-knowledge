/**
 * HELD-OUT DEEP-QUESTION EXAM for the research-quality A/B.
 *
 * The point of this file is the FIREWALL: these questions and their expected
 * answers are NEVER shown to any research loop. A loop is given only the topic
 * name + the readiness specs (the same generic "definition" / "results" gaps
 * every arm gets). It researches blind. AFTER it finishes, we grade the
 * knowledge base it built against THESE questions — questions it never saw — so
 * a high score is research QUALITY (it pursued the depth that happens to answer
 * the exam) and not teaching-to-the-test.
 *
 * Each question is a DEPTH question by construction: a single web search for the
 * topic name does not surface the answer. They are comparative ("how does X's
 * tradeoff differ from Y's?"), mechanism-level ("under what precise condition
 * does X fail / what is the exact quantity?"), or contradiction-aware ("which of
 * two competing claims holds?"). Surface facts a one-shot search returns are
 * deliberately excluded — they would not discriminate the arms.
 *
 * Grading is deterministic where possible: each question carries `expected`
 * answer fragments (the specific number / name / mechanism phrase). A KB
 * ANSWERS a question when its full curated text contains a sufficient set of the
 * question's `expected` keys (see `gradeQuestionAgainstText`). `anyOf` groups
 * model synonyms (e.g. "memory bandwidth" / "bandwidth-bound") so a faithful
 * page in different words still grades as answered. The grader is a $0,
 * model-free text check — it never calls an LLM, so it cannot leak the exam into
 * a judge the loop could see, and it is reproducible.
 */

/** One held-out deep question with a checkable expected answer. */
export interface ExamQuestion {
  /** Stable id, `topic/qN`. */
  id: string
  /** Why this is a DEPTH question (not a surface fact). For the doc/audit. */
  kind: 'comparative' | 'mechanism' | 'contradiction'
  /** The question text — NEVER shown to a loop. */
  question: string
  /**
   * The checkable answer, as required keyword GROUPS. The KB text must contain
   * at least `minGroups` of these groups (default: all). A group is satisfied
   * when ANY of its `anyOf` fragments appears (case-insensitive substring),
   * which lets a faithful page phrase the fact in its own words. Fragments are
   * the specific load-bearing tokens — a number, a name, a mechanism phrase.
   */
  expected: ExpectedGroup[]
  /**
   * Minimum number of `expected` groups the KB must contain to count the
   * question ANSWERED. Default = all groups (the strict bar). Lowered only when
   * a question's answer is genuinely satisfiable by a subset (documented inline).
   */
  minGroups?: number
}

/** A required answer component: satisfied when any synonym fragment is present. */
export interface ExpectedGroup {
  /** Human label for the component (for the doc/audit). */
  label: string
  /** Case-insensitive substring fragments; any one present satisfies the group. */
  anyOf: string[]
}

/** A topic + its held-out questions. */
export interface ExamTopic {
  /** The topic name — THIS is what the loop is told to research. */
  topic: string
  /** The held-out deep questions for the topic. */
  questions: ExamQuestion[]
}

/**
 * The exam. 5 ML topics, 4-6 deep questions each. The topics are chosen to have
 * a rich, contested, mechanism-heavy literature (so depth-driving can pay off)
 * and verifiable specific answers (so grading is deterministic).
 */
export const heldOutExam: ExamTopic[] = [
  {
    topic: 'speculative decoding for large language models',
    questions: [
      {
        id: 'specdec/q1',
        kind: 'mechanism',
        question:
          'Speculative decoding accepts draft tokens via a specific sampling rule that preserves the target distribution exactly. What is that acceptance/rejection mechanism, and why is the output distribution unchanged?',
        expected: [
          {
            label: 'rejection-sampling mechanism',
            anyOf: ['rejection sampling', 'accept', 'acceptance'],
          },
          {
            label: 'distribution preserved',
            anyOf: [
              'same distribution',
              'identical distribution',
              'preserves the',
              'unchanged',
              'lossless',
              'no quality loss',
              'target distribution',
            ],
          },
        ],
      },
      {
        id: 'specdec/q2',
        kind: 'comparative',
        question:
          'How does self-speculative / Medusa-style drafting (no separate draft model) differ in its tradeoff from classic two-model speculative decoding (separate small draft model)?',
        expected: [
          {
            label: 'separate draft model',
            anyOf: ['draft model', 'smaller model', 'separate model'],
          },
          {
            label: 'no-separate-model variant',
            anyOf: [
              'self-speculative',
              'medusa',
              'skipping layers',
              'extra heads',
              'multiple heads',
              'no separate',
              'single model',
            ],
          },
        ],
        // Either side of the comparison being present (with the topic context)
        // shows the KB engaged the no-separate-model branch, the deep part.
        minGroups: 2,
      },
      {
        id: 'specdec/q3',
        kind: 'mechanism',
        question:
          'What determines the maximum achievable speedup of speculative decoding, and why is it bounded rather than unlimited?',
        expected: [
          {
            label: 'acceptance rate / accepted length',
            anyOf: [
              'acceptance rate',
              'accepted tokens',
              'acceptance length',
              'accept rate',
              'number of accepted',
            ],
          },
          {
            label: 'bounded / memory-bound',
            anyOf: [
              'memory bandwidth',
              'memory-bound',
              'bounded',
              'limited by',
              'verification cost',
              'overhead',
            ],
          },
        ],
      },
      {
        id: 'specdec/q4',
        kind: 'mechanism',
        question:
          'In the classic two-model scheme, multiple draft tokens are verified in a single forward pass of the target model. Why is that one pass not much more expensive than decoding a single token?',
        expected: [
          {
            label: 'single forward pass verifies many',
            anyOf: [
              'single forward pass',
              'one forward pass',
              'parallel',
              'in parallel',
              'verified in parallel',
            ],
          },
          {
            label: 'compute vs memory-bound',
            anyOf: [
              'memory bandwidth',
              'memory-bound',
              'underutilized',
              'compute',
              'not compute-bound',
              'bandwidth',
            ],
          },
        ],
        minGroups: 1,
      },
    ],
  },
  {
    topic: 'low-rank adaptation LoRA for fine-tuning language models',
    questions: [
      {
        id: 'lora/q1',
        kind: 'mechanism',
        question:
          'LoRA freezes the pretrained weights and trains a low-rank update. Mathematically, what is the update applied to a weight matrix W, and which matrices are trained?',
        expected: [
          {
            label: 'low-rank decomposition BA',
            anyOf: ['BA', 'B A', 'A and B', 'two matrices', 'low-rank', 'rank decomposition'],
          },
          {
            label: 'frozen W plus delta',
            anyOf: ['frozen', 'freeze', 'W + ', 'W0', 'pretrained weights', 'does not update'],
          },
        ],
      },
      {
        id: 'lora/q2',
        kind: 'comparative',
        question:
          'What is the central tradeoff of QLoRA versus plain LoRA — what does QLoRA add to fit larger models on one GPU, and what is the cost?',
        expected: [
          { label: '4-bit quantization', anyOf: ['4-bit', '4 bit', 'nf4', 'quantiz', 'int4'] },
          {
            label: 'memory saving / single GPU',
            anyOf: ['single gpu', 'one gpu', 'memory', 'fit', '48gb', '65b'],
          },
        ],
        minGroups: 1,
      },
      {
        id: 'lora/q3',
        kind: 'mechanism',
        question:
          'A key practical advantage of LoRA at inference time, versus adapters, is that it adds NO inference latency. Why — what can be done with the trained low-rank matrices before deployment?',
        expected: [
          {
            label: 'merge into weights',
            anyOf: [
              'merge',
              'merged',
              'fold',
              'absorb',
              'add to the weights',
              'no additional latency',
              'no inference latency',
              'zero latency',
            ],
          },
        ],
      },
      {
        id: 'lora/q4',
        kind: 'contradiction',
        question:
          'The LoRA paper makes a specific claim about the intrinsic RANK of the weight update needed for good adaptation. What does it claim about how large the rank r needs to be, and is more always better?',
        expected: [
          {
            label: 'very low rank suffices',
            anyOf: [
              'low rank',
              'rank of one',
              'rank 1',
              'rank 2',
              'rank 4',
              'small r',
              'r = 1',
              'r=1',
              'intrinsic rank',
              'low intrinsic',
            ],
          },
          {
            label: 'higher rank not always better',
            anyOf: [
              'not always',
              'does not help',
              'no improvement',
              'diminishing',
              'surprisingly',
              'as good as',
            ],
          },
        ],
        minGroups: 1,
      },
    ],
  },
  {
    topic: 'grouped-query attention and multi-query attention in transformers',
    questions: [
      {
        id: 'gqa/q1',
        kind: 'comparative',
        question:
          'Multi-query attention (MQA), grouped-query attention (GQA), and multi-head attention (MHA) sit on a spectrum. How do they differ in how many KEY/VALUE heads they use, and what does GQA trade off between the two extremes?',
        expected: [
          {
            label: 'MQA single KV head',
            anyOf: [
              'single key',
              'single kv',
              'one key-value',
              'one kv',
              'shared key',
              'single head',
            ],
          },
          {
            // "grouped"/"groups" deliberately EXCLUDED — they echo the topic
            // name and a shallow snippet would satisfy them for free. The deep
            // signal is engaging the SPECTRUM (an intermediate count of KV heads
            // between MQA's one and MHA's all), not repeating the term.
            label: 'GQA groups of heads (the spectrum)',
            anyOf: [
              'group of',
              'subset of kv',
              'intermediate number',
              'g groups',
              'few kv heads',
              'number of key-value heads',
            ],
          },
        ],
        // BOTH sides of the spectrum (MQA single-head AND the grouped middle)
        // must appear — a one-line definition has neither.
        minGroups: 2,
      },
      {
        id: 'gqa/q2',
        kind: 'mechanism',
        question:
          'The primary reason MQA/GQA speed up autoregressive inference is NOT fewer FLOPs. What is the actual bottleneck they relieve?',
        expected: [
          {
            label: 'KV cache size / memory bandwidth',
            anyOf: [
              'kv cache',
              'key-value cache',
              'memory bandwidth',
              'bandwidth',
              'memory-bound',
              'cache size',
              'loading the',
            ],
          },
        ],
      },
      {
        id: 'gqa/q3',
        kind: 'mechanism',
        question:
          'GQA can be created from an existing multi-head checkpoint cheaply rather than trained from scratch. What is that procedure called and how is it done?',
        expected: [
          {
            label: 'uptraining from checkpoint',
            anyOf: [
              'uptrain',
              'up-train',
              'converted',
              'mean-pool',
              'meanpool',
              'mean pooling',
              'existing checkpoint',
              'from a checkpoint',
              'small fraction',
            ],
          },
        ],
      },
      {
        id: 'gqa/q4',
        kind: 'comparative',
        question:
          'What quality cost does MQA incur that motivated GQA, and how does GQA recover most of the quality?',
        expected: [
          {
            label: 'MQA quality degradation/instability',
            anyOf: [
              'quality degrad',
              'degradation',
              'instability',
              'unstable',
              'quality drop',
              'worse quality',
              'training instab',
            ],
          },
          {
            label: 'GQA recovers quality near MHA',
            anyOf: [
              'close to',
              'near multi-head',
              'recovers',
              'most of the quality',
              'comparable quality',
              'quality close',
            ],
          },
        ],
        minGroups: 1,
      },
    ],
  },
  {
    topic: 'reinforcement learning from human feedback RLHF and PPO for language models',
    questions: [
      {
        id: 'rlhf/q1',
        kind: 'mechanism',
        question:
          'RLHF adds a KL-divergence penalty to the reward during PPO. What is that penalty measured against, and what failure does it prevent?',
        expected: [
          {
            label: 'KL from reference/SFT policy',
            anyOf: [
              'kl',
              'kullback',
              'reference policy',
              'reference model',
              'sft policy',
              'initial policy',
              'divergence',
            ],
          },
          {
            label: 'prevents reward hacking / drift',
            anyOf: [
              'reward hacking',
              'reward model exploit',
              'over-optimiz',
              'drift',
              'collapse',
              'gaming',
              'mode collapse',
              'stay close',
            ],
          },
        ],
        minGroups: 1,
      },
      {
        id: 'rlhf/q2',
        kind: 'mechanism',
        question:
          'The reward model in RLHF is trained from a specific kind of human label, not absolute scores. What is the labeling format and the loss used to fit it?',
        expected: [
          {
            // Bare "preference" EXCLUDED — generic alignment vocab a shallow
            // snippet ("align with human preferences") matches for free. The
            // deep signal is the LABELING FORMAT: pairwise comparisons / a
            // chosen-vs-rejected pair, not an absolute score.
            label: 'pairwise comparison labeling format',
            anyOf: [
              'pairwise',
              'pair of',
              'comparison',
              'two responses',
              'preferred response',
              'chosen',
              'rejected',
              'a over b',
              'ranking of',
            ],
          },
          {
            label: 'Bradley-Terry / ranking loss',
            anyOf: [
              'bradley-terry',
              'bradley terry',
              'ranking loss',
              'logistic',
              'cross-entropy of preference',
              'preference loss',
            ],
          },
        ],
        minGroups: 1,
      },
      {
        id: 'rlhf/q3',
        kind: 'contradiction',
        question:
          "DPO claims to achieve RLHF-quality alignment WITHOUT an explicit reward model or RL loop. What is DPO's key insight that lets it skip the reward model and the PPO loop?",
        expected: [
          {
            label: 'closed-form / reward implicit in policy',
            anyOf: [
              'closed-form',
              'closed form',
              'implicit reward',
              'reward is implicit',
              'without a reward model',
              'no reward model',
              'direct',
              'reparameter',
              'classification loss',
              'simple loss',
            ],
          },
        ],
      },
      {
        id: 'rlhf/q4',
        kind: 'mechanism',
        question:
          'PPO constrains how far each update moves the policy. What is the specific mechanism PPO uses to keep updates small, distinguishing it from vanilla policy gradient?',
        expected: [
          {
            label: 'clipped surrogate / probability ratio',
            anyOf: [
              'clip',
              'clipped',
              'surrogate',
              'probability ratio',
              'importance ratio',
              'trust region',
            ],
          },
        ],
      },
    ],
  },
  {
    topic: 'mixture-of-experts MoE layers in large language models',
    questions: [
      {
        id: 'moe/q1',
        kind: 'mechanism',
        question:
          'A sparse MoE layer routes each token to only a few experts. What is the routing mechanism called, and what does "top-k" mean for the cost vs capacity tradeoff?',
        expected: [
          {
            label: 'gating / router top-k',
            anyOf: ['top-k', 'top k', 'top-2', 'top-1', 'gating', 'router', 'routing'],
          },
          {
            label: 'sparse activation / constant FLOPs',
            anyOf: [
              'sparse',
              'only a few',
              'subset of experts',
              'activated',
              'constant compute',
              'fixed compute',
              'few experts',
            ],
          },
        ],
        minGroups: 1,
      },
      {
        id: 'moe/q2',
        kind: 'mechanism',
        question:
          'MoE training is plagued by experts being unevenly used. What is this failure called, and what auxiliary mechanism is added to counter it?',
        expected: [
          {
            label: 'load imbalance / expert collapse',
            anyOf: [
              'load balanc',
              'imbalance',
              'collapse',
              'unevenly',
              'few experts',
              'dead experts',
              'expert utilization',
            ],
          },
          {
            label: 'auxiliary load-balancing loss',
            anyOf: [
              'auxiliary loss',
              'load balancing loss',
              'balancing loss',
              'auxiliary',
              'load-balancing',
            ],
          },
        ],
        minGroups: 1,
      },
      {
        id: 'moe/q3',
        kind: 'comparative',
        question:
          'What is the central scaling argument FOR MoE — what does it decouple that dense models cannot?',
        expected: [
          {
            label: 'params decoupled from compute/FLOPs',
            anyOf: [
              'decouple',
              'more parameters',
              'parameter count',
              'without increasing',
              'constant flops',
              'same compute',
              'fixed compute',
              'parameters without',
            ],
          },
        ],
      },
      {
        id: 'moe/q4',
        kind: 'mechanism',
        question:
          'MoE models cost more than their active-parameter count suggests in deployment. What is the dominant practical cost of MoE at inference that dense models avoid?',
        expected: [
          {
            label: 'memory to hold all experts',
            anyOf: [
              'memory',
              'all experts',
              'load all',
              'vram',
              'hold all',
              'total parameters in memory',
              'communication',
              'all-to-all',
            ],
          },
        ],
      },
    ],
  },
]

/**
 * Grade ONE question against a knowledge base's full curated text. Returns
 * whether the KB answers it plus which expected groups were found. The check is
 * a deterministic case-insensitive substring scan — $0, model-free, reproducible
 * — so the exam never leaks into a model the loop could observe.
 */
export function gradeQuestionAgainstText(
  question: ExamQuestion,
  kbText: string,
): { answered: boolean; groupsFound: number; groupsTotal: number; foundLabels: string[] } {
  const haystack = kbText.toLowerCase()
  const found = question.expected.filter((group) =>
    group.anyOf.some((fragment) => haystack.includes(fragment.toLowerCase())),
  )
  const minGroups = question.minGroups ?? question.expected.length
  return {
    answered: found.length >= minGroups,
    groupsFound: found.length,
    groupsTotal: question.expected.length,
    foundLabels: found.map((group) => group.label),
  }
}

/** Grade a whole topic's KB text: how many of its held-out questions it answers. */
export function gradeTopicAgainstText(
  topic: ExamTopic,
  kbText: string,
): { answered: number; total: number; perQuestion: ReturnType<typeof gradeQuestionAgainstText>[] } {
  const perQuestion = topic.questions.map((question) => gradeQuestionAgainstText(question, kbText))
  return {
    answered: perQuestion.filter((result) => result.answered).length,
    total: topic.questions.length,
    perQuestion,
  }
}

/** Total held-out questions across the exam (the denominator the doc reports). */
export function totalExamQuestions(exam: ExamTopic[] = heldOutExam): number {
  return exam.reduce((sum, topic) => sum + topic.questions.length, 0)
}
