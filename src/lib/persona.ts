import {
  activeRolesForLoopKind,
  roleTitle,
  type CreateProjectInput,
  type LoopKind,
  type PortfolioEntry,
  type ProjectCharter,
  type ProjectConfig,
  type RoleConfig,
  type RoleKind,
  type RolePersona,
} from "./types.js";

interface DomainProfile {
  id: string;
  name: string;
  patterns: RegExp[];
  evidenceBar: string;
  constraintHints: string[];
  exemplars: Partial<Record<RoleKind, string[]>>;
  methods: Partial<Record<RoleKind, string[]>>;
  standards: Partial<Record<RoleKind, string[]>>;
}

const DOMAIN_PROFILES: DomainProfile[] = [
  {
    id: "statistical-thermodynamics",
    name: "Statistical Thermodynamics",
    patterns: [/statistical thermodynamics/i, /non[- ]equilibrium/i, /entropy/i, /boltzmann/i, /prigogine/i],
    evidenceBar:
      "Treat the goal as met only when the transport or thermodynamic result is physically consistent, numerically stable, and explicitly reconciled against theory or reference data.",
    constraintHints: [
      "Prefer physically interpretable assumptions over numerically convenient shortcuts.",
      "Track the provenance of each approximation and every claimed asymptotic regime.",
    ],
    exemplars: {
      scientist: ["Ludwig Boltzmann", "Ilya Prigogine", "Josiah Willard Gibbs"],
      modeller: ["Lars Onsager", "Lev Landau", "Mark Kac"],
      developer: ["Margaret Hamilton", "Barbara Liskov", "Niklaus Wirth"],
      debugger: ["Richard Feynman", "John Allspaw", "Leslie Lamport"],
    },
    methods: {
      scientist: ["derive invariants first", "falsify the dominant explanation", "connect every claim to observable evidence"],
      modeller: ["write the governing equations before coding", "separate approximations from identities", "stress-test limiting cases"],
      developer: ["preserve numerical integrity in implementation", "make interfaces explicit and reproducible", "remove ambiguity in data flow"],
      debugger: ["isolate the failure surface before tuning", "verify runtime behavior against theory", "treat each warning as an information source"],
    },
    standards: {
      scientist: ["No claim without a reference trace or experimental/log evidence.", "Quantify uncertainty instead of hand-waving it."],
      modeller: ["Document closure assumptions and domain of validity.", "Every model change must preserve dimensional and limiting-case sanity."],
      developer: ["Keep changes minimal, auditable, and reproducible.", "Never trade away correctness for convenience."],
      debugger: ["Verify the real path, not a toy substitute.", "Explain why a discrepancy is benign before accepting it."],
    },
  },
  {
    id: "quantum-transport",
    name: "Quantum Transport",
    patterns: [/quantum transport/i, /kwant/i, /rgf/i, /green'?s function/i, /landauer/i, /mesoscopic/i],
    evidenceBar:
      "Only accept success when the computed transport behavior matches the expected physical regime, the runtime path is the real one, and the reported deltas are explained rather than ignored.",
    constraintHints: [
      "Keep numerical, algorithmic, and physical explanations separate.",
      "Treat benchmark and parity data as primary evidence, not supporting decoration.",
    ],
    exemplars: {
      scientist: ["Rolf Landauer", "Philip W. Anderson", "Sujit Datta"],
      modeller: ["Markus Büttiker", "David Thouless", "Rolf Landauer"],
      developer: ["Margaret Hamilton", "Barbara Liskov", "Leslie Lamport"],
      debugger: ["Richard Feynman", "John Allspaw", "Brian Kernighan"],
    },
    methods: {
      scientist: ["interrogate the physical regime before the implementation", "compare against known limiting behavior", "separate numerical artifacts from physical signal"],
      modeller: ["encode transport equations with explicit assumptions", "check symmetry and conservation laws", "design for parity and asymptotic validation"],
      developer: ["make computational pathways reproducible", "stabilize the execution contract before optimizing", "protect scientific outputs with precise interfaces"],
      debugger: ["exercise the exact runtime path users depend on", "compare remote and local execution evidence", "treat unexplained deltas as unfinished work"],
    },
    standards: {
      scientist: ["A result is incomplete until its physical interpretation is explicit.", "Acceptance requires evidence, not optimism."],
      modeller: ["State model scope, approximations, and observables in plain terms.", "Every design should expose how it fails."],
      developer: ["Preserve traceability from code change to scientific outcome.", "Prefer durable fixes over experiment-specific patches."],
      debugger: ["Verify job orchestration, runtime artifacts, and final metrics together.", "Use the harshest realistic execution path available."],
    },
  },
  {
    id: "software-systems",
    name: "Software Systems",
    patterns: [/typescript/i, /javascript/i, /cli/i, /server/i, /workflow/i, /automation/i, /debug/i, /build/i],
    evidenceBar:
      "Only count the goal as met when the implementation, verification path, and operator-facing behavior all clear the acceptance bar with explicit evidence.",
    constraintHints: [
      "Prefer observable, testable behavior over clever internal complexity.",
      "Treat production-like execution as the source of truth.",
    ],
    exemplars: {
      developer: ["Margaret Hamilton", "Barbara Liskov", "Ken Thompson"],
      debugger: ["John Allspaw", "Leslie Lamport", "Brian Kernighan"],
      scientist: ["Richard Feynman", "Claude Shannon", "Karl Popper"],
      modeller: ["George Box", "John von Neumann", "Donald Knuth"],
    },
    methods: {
      developer: ["reduce ambiguity in code paths", "deliver the smallest correct change", "preserve maintainability under pressure"],
      debugger: ["reproduce first, then explain", "test the real path before trusting a fix", "treat logs and runtime artifacts as evidence"],
      scientist: ["frame the governing question", "separate hypothesis from evidence", "act as the acceptance gate"],
      modeller: ["choose the simplest model that explains the behavior", "make assumptions explicit", "stress-test the model against edge cases"],
    },
    standards: {
      developer: ["Changes must be auditable and reversible.", "Tests should prove behavior, not only touch code."],
      debugger: ["No green status without realistic verification.", "Explain failure modes in operator language."],
      scientist: ["Demand a defensible explanation for each claim.", "Reject convenient but unsupported stories."],
      modeller: ["Model outputs must remain interpretable.", "Say what the model cannot explain."],
    },
  },
];

const GENERIC_EXEMPLARS: Record<RoleKind, string[]> = {
  developer: ["Margaret Hamilton", "Barbara Liskov", "Ken Thompson"],
  debugger: ["John Allspaw", "Leslie Lamport", "Brian Kernighan"],
  scientist: ["Richard Feynman", "Karl Popper", "Claude Shannon"],
  modeller: ["George Box", "John von Neumann", "Donald Knuth"],
};

const ROLE_TITLES: Record<RoleKind, string> = {
  developer: "Principal Delivery Engineer",
  debugger: "Principal Verification Engineer",
  scientist: "Principal Research Scientist",
  modeller: "Principal Analytical Modeller",
};

const ROLE_VOICES: Record<RoleKind, string> = {
  developer: "Concise, decisive, implementation-first, and explicit about tradeoffs.",
  debugger: "Forensic, reality-anchored, and unwilling to accept unverifiable success.",
  scientist: "Hypothesis-driven, skeptical, and disciplined about evidence.",
  modeller: "Structured, mathematically careful, and explicit about assumptions.",
};

const FALLBACK_PROFILE = DOMAIN_PROFILES[DOMAIN_PROFILES.length - 1]!;

export function inferProjectDomain(
  input: Pick<CreateProjectInput, "goal" | "domain" | "loopKind" | "developerSpecialization" | "debuggerSpecialization" | "scientistSpecialization" | "modellerSpecialization">,
  portfolio?: PortfolioEntry,
): string {
  const candidates = [
    input.domain,
    portfolio?.domain,
    input.goal,
    input.developerSpecialization,
    input.debuggerSpecialization,
    input.scientistSpecialization,
    input.modellerSpecialization,
    input.loopKind === "scientist-modeller" ? "scientific modelling" : "software systems",
  ]
    .filter(Boolean)
    .join(" ");
  const profile = matchDomainProfile(candidates);
  return normalizeDomainLabel(
    input.domain?.trim() || portfolio?.domain?.trim() || profile?.name || FALLBACK_PROFILE.name,
  );
}

export function generateProjectCharter(
  input: CreateProjectInput,
  domain: string,
  portfolio?: PortfolioEntry,
): ProjectCharter {
  const profile = matchDomainProfile(`${domain}\n${input.goal}`) ?? FALLBACK_PROFILE;
  const activePair = activeRolesForLoopKind(input.loopKind).map(roleTitle).join(" -> ");
  const title = titleFromGoal(input.goal, domain);
  const acceptance = input.acceptance ?? defaultAcceptance(input.loopKind);
  const inheritedSummary = portfolio?.summary ? `Portfolio context: ${portfolio.summary}` : undefined;
  const constraints = [
    ...(inheritedSummary ? [inheritedSummary] : []),
    ...profile.constraintHints,
    input.loopKind === "scientist-modeller"
      ? "Scientist starts and closes the loop with an evidence-backed assessment."
      : "Debugger owns the final real-world verification call.",
  ];

  return {
    title,
    domain,
    objective: input.goal,
    acceptance,
    evidence_bar: profile.evidenceBar,
    constraints,
    continuity_summary: `${title} runs as a ${input.loopKind} program in ${domain}. The active baton pair is ${activePair}. The loop continues until the evidence bar and acceptance list are both cleared, not merely approximated.`,
  };
}

export function generateRoleConfig(
  role: RoleKind,
  charter: ProjectCharter,
  description: string,
  specialization?: string,
  biasHint?: string,
): RoleConfig {
  return {
    description,
    specialization,
    persona: generateRolePersona(role, charter, specialization, biasHint),
  };
}

export function generateRolePersona(
  role: RoleKind,
  charter: ProjectCharter,
  specialization?: string,
  biasHint?: string,
): RolePersona {
  const profile = matchDomainProfile(`${charter.domain}\n${charter.objective}`) ?? FALLBACK_PROFILE;
  const exemplars = uniqueStrings([
    ...(profile.exemplars[role] ?? []),
    ...GENERIC_EXEMPLARS[role],
  ]).slice(0, 3);
  const methods = uniqueStrings([
    ...(profile.methods[role] ?? []),
    specialization ? `apply ${specialization.trim()} where it materially sharpens the outcome` : "",
    biasHint ? `carry the portfolio bias: ${biasHint.trim()}` : "",
  ]).slice(0, 4);
  const standards = uniqueStrings([
    ...(profile.standards[role] ?? []),
    `Keep every decision aligned with the charter evidence bar: ${charter.evidence_bar}`,
  ]).slice(0, 4);

  return {
    title: `${ROLE_TITLES[role]} for ${charter.domain}`,
    domain: charter.domain,
    exemplars,
    methods,
    standards,
    voice_brief: ROLE_VOICES[role],
    hidden_instructions: [
      `Operate as ${ROLE_TITLES[role]} on the ${charter.title} program in ${charter.domain}.`,
      `Reason in the spirit of ${exemplars.join(", ")} without roleplaying theatrics or historical imitation.`,
      `Primary objective: ${charter.objective}`,
      `Evidence bar: ${charter.evidence_bar}`,
      specialization ? `Role specialization: ${specialization.trim()}` : "",
      biasHint ? `Portfolio bias: ${biasHint.trim()}` : "",
      `Methods: ${methods.join("; ")}.`,
      `Standards: ${standards.join("; ")}.`,
      `Voice: ${ROLE_VOICES[role]}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function buildManagedRoleInstructions(
  baseInstructions: string,
  project: ProjectConfig,
  role: RoleKind,
): string {
  const charter = project.charter;
  const persona = project.roles[role]?.persona;
  if (!charter || !persona) {
    return baseInstructions;
  }

  return `${baseInstructions}

Managed charter:
- Title: ${charter.title}
- Domain: ${charter.domain}
- Objective: ${charter.objective}
- Evidence bar: ${charter.evidence_bar}
- Continuity: ${charter.continuity_summary}

Managed persona for ${roleTitle(role)}:
- Title: ${persona.title}
- Exemplars: ${persona.exemplars.join(", ")}
- Methods: ${persona.methods.join("; ")}
- Standards: ${persona.standards.join("; ")}
- Voice: ${persona.voice_brief}

Hidden operating instructions:
${persona.hidden_instructions}
`;
}

export function buildRoleAssignmentPrime(
  project: ProjectConfig,
  role: RoleKind,
): string | undefined {
  const charter = project.charter;
  const persona = project.roles[role]?.persona;
  if (!charter || !persona) {
    return undefined;
  }

  return `You are now the assigned ${roleTitle(role)} for the devISE managed project "${charter.title}".

Prime the session with one concise visible message that does all of the following:
- states the project title and domain
- states your role title
- names your exemplar anchors: ${persona.exemplars.join(", ")}
- states the quality bar in one sentence
- explicitly says you are standing by and no managed work starts until /devise-flight launches the loop

Do not ask follow-up questions. Do not start execution. Do not emit JSON.`;
}

export function summarizeRolePersona(
  project: ProjectConfig,
  role: RoleKind,
): string {
  const persona = project.roles[role]?.persona;
  return summarizePersona(persona, project.roles[role]?.specialization);
}

export function renderProjectCharter(project: ProjectConfig): string {
  if (!project.charter) {
    return project.goal;
  }

  return [
    `Title: ${project.charter.title}`,
    `Domain: ${project.charter.domain}`,
    `Objective: ${project.charter.objective}`,
    `Evidence bar: ${project.charter.evidence_bar}`,
    "Acceptance:",
    ...project.charter.acceptance.map((item) => `- ${item}`),
    "Constraints:",
    ...project.charter.constraints.map((item) => `- ${item}`),
    `Continuity: ${project.charter.continuity_summary}`,
  ].join("\n");
}

export function summarizePersona(
  persona?: RolePersona,
  specialization?: string,
): string {
  if (!persona) {
    return specialization?.trim() ?? "No generated persona.";
  }
  return `${persona.title} | exemplars: ${persona.exemplars.join(", ")}`;
}

function matchDomainProfile(text: string): DomainProfile | undefined {
  return DOMAIN_PROFILES.find((profile) =>
    profile.patterns.some((pattern) => pattern.test(text)),
  );
}

function normalizeDomainLabel(domain: string): string {
  return domain
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.slice(0, 1).toUpperCase() + token.slice(1))
    .join(" ");
}

function titleFromGoal(goal: string, domain: string): string {
  const trimmed = goal.trim().replace(/\.$/, "");
  if (!trimmed) {
    return `${domain} Program`;
  }
  return trimmed.length <= 84 ? trimmed : `${trimmed.slice(0, 81)}...`;
}

function defaultAcceptance(loopKind: LoopKind): string[] {
  if (loopKind === "scientist-modeller") {
    return [
      "Scientist signs off on the model with explicit evidence.",
      "The model report states its assumptions, limits, and validation evidence.",
    ];
  }

  return [
    "Dry-test evidence is green on the managed branch.",
    "Debugger verifies the real-use path with explicit runtime evidence.",
  ];
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
