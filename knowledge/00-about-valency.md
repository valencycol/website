# About Valency Colaco

> This is the primary knowledge file for the site's AI assistant.
> Edit it freely — the assistant reads it live at runtime, no rebuild needed.
> Lines marked `TODO:` are placeholders for you to fill in.

## Identity

- **Full name:** Valency Oscar Colaco
- **Goes by:** Valency
- **Role:** Cybersecurity & AI/ML Researcher
- **Affiliation:** Linköping University (LiU), Sweden — CYBER, Department of Computer and Information Science (IDA)
- **Location:** Sweden
- **Website:** https://colaco.se
- **Google Scholar:** https://scholar.google.com/citations?user=xMG8t8oAAAAJ&hl=en
- **Contact:** through the contact form on colaco.se (`/contact` in the terminal)
- **Doctoral advisor:** Prof. Simin Nadjm-Tehrani
- TODO: LinkedIn URL
- TODO: GitHub URL
- TODO: ORCID

## One-line summary

Valency Colaco researches the security of machine learning models used in
safety-critical systems — specifically how tree ensembles used as intrusion
detection systems can be evaded, and how to detect those evasions fast enough
to run in real time.

## Research focus

Valency's work sits at the intersection of **adversarial machine learning** and
**intrusion detection**. Four threads run through it:

1. **Evasion attacks on tree ensembles.** Gradient-boosted trees and random
   forests are widely deployed as intrusion detection systems (IDSs) because
   they are fast and interpretable. They are also evadable: an attacker can
   perturb a malicious input just enough to cross the decision boundary.

2. **Reactive defences instead of proactive ones.** A central finding of the
   licentiate thesis is that *proactive* defences — chiefly adversarial
   retraining — are ineffective for tree ensembles and can make them *more*
   vulnerable. Valency argues for reactive detection: leave the model alone,
   and put a detector in front of it.

3. **Real-time constraints.** Detection that takes hundreds of milliseconds is
   useless on an automotive CAN bus. Much of the contribution is making
   detection orders of magnitude faster at equal accuracy.

4. **Formal verification.** Proving robustness properties of tree ensembles
   under realistic, composite perturbations rather than simple L-norm balls.

## Named systems

- **Iceman** — a counterexample-region-based evasion detector for
  tree-ensemble IDSs. >98% detection accuracy, 5–115× lower latency than the
  prior state of the art (OC-Score, ECML PKDD 2023), and it emits quaternary
  attack annotations so analysts can triage alerts rather than drown in them.

- **Maverick** — an autoencoder-based evasion detector for *automotive*
  tree-ensemble IDSs. Matches OC-Score's detection accuracy exactly while
  running 85–563× faster, which is what makes it viable inside the timing
  budget of an automotive CAN network.

- **VoTE extension** — extends the VoTE verification tool to check tree
  ensembles against *composite geometric* perturbations (affine transforms
  plus pixel-wise lighting changes) via a new abstraction-function-based
  robustness property checker.

## Publications

### 2026 — Improving SIEM Rules using Transformer-Based Rule Evasion Detection and Attribution
- **Type:** Conference paper
- **Authors:** Erik Nordström · Hannes Widén · Valency Oscar Colaco · Simin Nadjm-Tehrani
- **Link:** https://doi.org/10.1007/978-3-032-33260-8_5
- **Summary:** A transformer-based approach that detects SIGMA rule evasions
  with accuracy comparable to the state of the art (AMIDES, USENIX Security
  2024), at a false positive rate below 1%. Beyond detection it *attributes*
  an evasion to the specific rule it defeats and recommends a fix. Several of
  those recommended fixes have been accepted into the upstream SIGMA
  repository.

### 2025 — Hardening Tree Ensembles: Real-Time and Effective Evasion Defences Beyond Adversarial Re-Training
- **Type:** Licentiate thesis, Linköping University
- **Author:** Valency Oscar Colaco
- **Link:** https://www.diva-portal.org/smash/get/diva2:2013682/FULLTEXT01.pdf
- **Summary:** Shows that proactive defences such as adversarial retraining are
  ineffective for tree ensembles and can inadvertently make them more
  vulnerable to evasion attacks. Introduces Iceman and Maverick — two reactive
  prototype systems that advance the state of the art in evasion detection
  performance and speed without modifying the underlying tree ensemble.

### 2025 — Real-Time Evasion Detection in Tree Ensemble Automotive Intrusion Detection Systems
- **Type:** Conference paper
- **Authors:** Valency Oscar Colaco · Simin Nadjm-Tehrani
- **Link:** https://www.ida.liu.se/labs/rtslab/publications/2025/maverick.pdf
- **Summary:** Introduces Maverick. Identical detection accuracy to OC-Score
  (ECML PKDD 2023) with 85–563× faster detection, enabling real-time operation
  within automotive CAN network constraints.

### 2024 — Fast Evasion Detection & Alert Management in Tree-Ensemble-Based Intrusion Detection Systems
- **Type:** Conference paper
- **Authors:** Valency Oscar Colaco · Simin Nadjm-Tehrani
- **Link:** https://www.ida.liu.se/labs/rtslab/publications/2024/Iceman_IEEE.pdf
- **Summary:** Introduces Iceman. >98% detection accuracy, 5–115× lower latency
  than OC-Score, plus quaternary attack annotations for effective alert triage.

### 2023 — Formal Verification of Tree Ensembles against Real-World Composite Geometric Perturbations
- **Type:** Workshop paper (SafeAI)
- **Authors:** Valency Oscar Colaco · Simin Nadjm-Tehrani
- **Link:** https://www.ida.liu.se/labs/rtslab/publications/2023/SafeAI2023_Valency.pdf
- **Summary:** Extends VoTE to verify tree ensembles against composite
  geometric perturbations by introducing an abstraction-function-based
  robustness property checker. Shows that targeted data augmentation fails to
  improve robustness and can even reduce it.

## Topics Valency can speak to

Adversarial machine learning · evasion attacks · tree ensembles (XGBoost,
random forests, gradient boosting) · intrusion detection systems · automotive
security and CAN bus · SIEM and SIGMA rules · alert triage and alert fatigue ·
formal verification of ML models · robustness certification · autoencoders for
anomaly detection · real-time systems constraints · safety-critical ML.

## Things this site can do

The site is a terminal. Visitors type slash-commands:

- `/help` — list every command
- `/about`, `/whoami` — this bio
- `/publications` (aliases `/research`, `/papers`) — Published Papers
- `/cybersecurity-news` (aliases `/cyber`, `/sec`) — live security feed (The
  Hacker News, BleepingComputer, Krebs on Security, SecurityWeek), CISA
  advisories, and the CISA KEV catalogue
- `/cve` (alias `/kev`) — CISA known-exploited vulnerabilities
- `/news` — Ground News top stories with left/center/right media-bias breakdown
- `/games` (alias `/arcade`) — six browser games
- `/contact` — send Valency a message
- `/scholar` — open the Google Scholar profile
- `/sources` — list the documents the assistant is allowed to read
- `/upload` — add your own documents for the current session only
- `/forget` — remove an uploaded document (`/forget all` clears them)
- `/fun` — suggested questions worth asking
- `/theme` — phosphor colour: green, amber or ice
- `/banner`, `/clear`, `/date`, `/exit` — terminal housekeeping

Anything typed that is *not* a command is sent to the AI assistant. It looks
in these documents first and answers from them when it can, citing which ones.
When the documents don't cover the question it answers from its own general
knowledge instead, and says so. The assistant endpoint is protected by
Cloudflare Turnstile, solved once behind the boot screen.

Question text is retained for 14 days so Valency can see what visitors ask.
No IP address or identifier is stored with it, and nothing links one question
to another. Uploaded files never leave the browser.

## TODO: fill these in

- TODO: Education history (BSc / MSc — institutions and years)
- TODO: Work experience outside academia
- TODO: Teaching — courses taught or assisted
- TODO: Talks and invited presentations
- TODO: Awards, grants, funding
- TODO: Languages spoken
- TODO: Current projects — what you're working on right now
- TODO: Availability — open to collaborations? reviewing? speaking?
- TODO: Personal interests you're happy to have a chatbot mention
