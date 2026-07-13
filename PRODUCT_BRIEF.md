# Product Brief — for a strategy agent with zero prior context

**Your mission:** You are tasked with making the owner of this product extremely rich — turning a ¥10k-per-seat factory MES into a $100M+ USD ARR company, fast, in China. This document gives you *exactly what the product does* and *real live data from the one factory it runs in*, so you can build the plan. You have no other context; everything you need is below. Read it all before planning.

---

## PART 0 — TL;DR

- **What it is:** a web-based MES (manufacturing execution system) for Chinese precision-machining job shops — the kind that make **多样小批量** (high-mix, low-volume) custom metal/plastic parts: prototypes and small production runs, ~200 different parts in the shop at once.
- **Who runs it:** one real factory today — a Hangzhou 手板/CNC shop (CNC machining + finishing) doing **~¥40M/year revenue**, **36 employees**, making parts for China's biggest tech hardware companies (Hikvision, Dahua, Scantech, solar + medical-robotics firms — see live data below).
- **What it sells for today:** ~¥10k. This is the problem. The tool is worth ~80×, not 10×, what it charges.
- **Why the boss loves it (the 80× claim):** two things — (1) **tracking components through production** and (2) **seeing the money per order**. Both were previously *near-impossible*, not just "hard." It's not a 10% workflow improvement; it converts an unknowable mess into a single live screen.
- **Product-market fit:** achieved. The factory runs its daily operations on it. In 45 days it logged 817 orders, 4,228 parts, 39,082 stage-tracking events.
- **The strategic question for you:** the MES is the wedge and the data-acquisition layer, not the end product. Figure out the revenue streams that ride on top of the flows it observes (money, materials, outsourcing capacity, labor) and the fastest way to saturate the market of these factories.
- **The headline answer this brief argues toward (don't re-soften it — see Part 8.5):** the wedge is the AI-import + component-tracking + finance MES (cheap/free, to win density fast via the multi-sided 外协 network). The fast software revenue is **AI digital-labor** (AI 报价员/跟单, priced vs. salaries, no regulation). The **primary cash engine is embedded lending against verified receivables** — ~50–100× the per-customer revenue of SaaS, made *low-risk* because the product already sees confirmed invoices owed by blue-chip end-payers (Hikvision/Dahua/Scantech) and 91–96% of orders are repeat. **Software plants; lending harvests.** Your job is to make this concrete and sequenced, not to second-guess whether lending is worth it — it is.

---

## PART 1 — The business situation in plain terms

A "job shop" / 手板厂 takes a customer's drawing or Excel BOM and makes the physical parts: CNC-machine aluminum, mill plastic, 3D-print, then finish (grind, anodize, paint, silkscreen), inspect, and ship. They run **hundreds of distinct small orders simultaneously**, each order containing several different parts, each part taking a different path through ~10 production stations. Much of the finishing (anodizing, plating, painting, special welding) is **outsourced (外协)** to specialist vendors and must come back before the order ships.

The chaos this creates is the core problem the product solves:
- **200 parts × ~9 stages × 36 people = thousands of "where is this right now?" questions per day.** Historically tracked on whiteboards, paper travelers, WeChat messages, and the boss's memory. Effectively untrackable.
- **Money per order was invisible until (or after) month-end.** Each order's true margin = sale price − outsourcing cost − materials − labor. With parts scattered across in-house stations and external vendors, the boss never knew per-order profit in real time, and routinely shipped without a contract, under-quoted, or lost track of receivables.

The product turns both into a live, per-part, per-yuan screen. That's the "80×."

---

## PART 2 — LIVE DATA FROM THE FACTORY (real, pulled today)

Pulled directly from the production database on **2026-06-20**. The database currently holds **~45 days** of activity (first order 2026-05-06). Treat these as a 45-day operating snapshot, not annual totals.

### Volume (45 days)
| Metric | Value | Implication |
|---|---|---|
| Orders (jobs) created | **817** (~18/day) | 746 confirmed/`ready`, 56 failed AI parses, 9 draft, 6 parsing |
| Distinct parts tracked | **4,228** | ~5 parts per order |
| Per-part-per-stage tracking cells | **39,082** | 29,641 done · 8,863 pending · 578 in-progress *right now* |
| Shipments issued | **276** | |
| Outsource dispatches (外协 blocks) | **209** (~4.6/day) | heavy reliance on external vendors |
| External vendors in network | **38** | the 外协 supply graph (see below) |
| Inspection reports generated | **79** | |
| Customer returns logged | **10** | |
| Users on the system | **36** | 26 floor/production, 10 commerce |
| Floor roles assigned | 工程 15 · 编程 6 · 操机 3 · 质量 2 | the production org chart, live |

> Order volume annualizes to **~6,500 orders/year** at this run-rate. Revenue is ~¥40M/year, so average realized order ≈ ¥6k, with a long tail of tiny repeat orders and a head of large ones.

### Money captured (45 days)
- **¥4.12M** in order value across the **372 priced orders** (only ~half of confirmed orders had a price entered — pricing discipline is partial; this is itself an opportunity).
- Average priced order: **~¥11k**.

### Who the customers actually are (real, top by order count & by spend)
The factory makes precision parts for **the top tier of Chinese tech hardware**. Real names in the database:

| Customer | What they are | Orders (45d) | Spend (¥) |
|---|---|---|---|
| 海康威视 (Hikvision) | World's #1 video-surveillance company | ~155 (across name variants) | ~¥370k+ |
| 大华 (Dahua) | World's #2 surveillance | 54 | ¥202k |
| 思看科技 (Scantech) | 3D-scanning, publicly listed | ~56 | ¥543k |
| 五八智能 (Wuba Intelligent) | Robotics | ~77 | ¥1.08M |
| 萤石 (EZVIZ) | Smart-home (Hikvision brand) | 11 | ¥30k |
| 艾罗网络能源 (AIRO/Solax) | Solar inverters, publicly listed | ~13 | ¥489k |
| 执鼎医疗 / 康基唯精 | Surgical-robotics firms | ~17 | ¥106k |
| 微影 (Vmovie) | imaging/tech | ~42 | ¥162k |
| 道禾, 丰衡机电, 唯精, 深度, 海康汽车 … | mix of hardware/medical/industrial | tail | tail |

**Two critical takeaways for strategy:**
1. **The customers are blue-chip.** This tiny ¥40M shop sits in the prototype/small-batch supply chain of Hikvision, Dahua, Scantech, listed solar and surgical-robotics companies. The "customer-of-customer" is the cream of Chinese tech manufacturing — a powerful demand-side lever.
2. **The data is raw/unnormalized.** Hikvision appears as 海康, 海康威视, 杭州海康威视数字技术股份有限公司, 海康仓库, 海康批量, 威视数字 … The 149 "distinct customers" in the DB are really ~40–50 real entities. Customer names come straight from whatever the AI read off the order doc. (Entity-resolution is both a data-quality gap and a future product hook.)

### The 外协 (outsourcing) network — 38 real vendors
Names reveal the supply graph this factory depends on:
- **Surface finishing:** 临安氧化 (anodizing), plating/oxidation shops in 厦门 (厦门佰昌, 厦门廖德金, 厦门季城, 厦门顺鹭), 浙文-全透
- **3D printing / rapid:** 金锐三维, 宁波金锐三维, 冠宇三维, 鸿维模型, 云智
- **Specialty:** 激光焊接 (laser welding), 橡胶厂 (rubber), 捷特链业 (chain), plus generic 外购 / 淘宝 (buy-from-Taobao)
- Many are individual craftsmen (维客达 巫朝文, 瑞鑫 李成义, 厦门佰昌-傅来金水) — i.e. a long tail of small specialist suppliers.

**209 outsource dispatches in 45 days across 38 vendors.** Each factory like this has 30–50 such vendors; each vendor serves many factories. This is a dense, real, multi-sided supply network already captured in the data.

### Materials (top, by part count)
Aluminum-dominant precision machining + plastics + magnesium + 3D print:
`6061 (335) · ABS (230) · 6061-T6 (185) · AL6061 (161) · PC (138) · 树脂/resin (130) · 7075 (122) · 7075-T6 (94) · 防火ABS (80) · 客供/customer-supplied (73) · 阻燃ABS (68) · 铝合金 (63) · 3D打印 (61) · ZK61M-T5 magnesium (59)`

### Production-stage workload (where the work sits)
Per-part-per-stage cell counts confirm nearly every part flows through the full pipeline: 出货 4194 · 工程 4172 · 质量 4170 · 检验 4137 · 手工 4124 · 打磨 4061 · 喷漆 3781 · 丝印 3668 · 编程 3410 · 操机 3365.

### Finance modules: built but barely used yet
The detailed ledgers are **brand new**: `shipment_finance` has **1 row out of 276 shipments** (0.4% capture — invoiced/paid columns essentially empty), `procurements` 3 rows, `expenses` 2 rows. The boss's "money love" today comes from the **order-money overview** (which derives from order amount + outsource spend + shipments — all populated), **not** the manual AR/expense ledgers (which are nascent). Closing this gap — getting receivables/payments/expenses actually entered — is a near-term product and data opportunity, and a prerequisite for the financing play in Part 9.

### Order shape & customer stickiness (real, 45d)
- **Parts per order:** avg **5.6**, median **2**, p90 **13**, max **150**. Distribution: 1 part → 292 orders · 2–5 → 268 · 6–20 → 159 · 21+ → 37. So it's a barbell: lots of tiny 1–2-part reorders **plus** a meaningful tail of big 20–150-part orders. The product has to handle both.
- **Repeat-order rate (the key stickiness number):** **~91–96% of all orders come from repeat customers** (raw 91%; after light name-normalization 96%). ~58–61% of distinct customers have ordered more than once. This is a **stable, recurring, predictable order base** — which matters enormously for the financing thesis: you're lending against a relationship that reorders monthly, not a one-shot.
- **外协 turnaround:** most outsource blocks have no recorded `actual_return` date yet (return tracking is logged via per-part returns, not the block-level date field), so a clean average couldn't be computed from the block table — flag for the planning agent as a data-capture gap, not an absence of outsourcing (209 blocks in 45 days is heavy).

---

## PART 3 — FULL FEATURE BREAKDOWN (what the product does)

The two pillars the boss pays for are **(A) Component Tracking** and **(B) Finance**. Everything else supports those.

### A. Component tracking (the operational core — "80×" pillar #1)

**The unit of work:** every order ("job", 工单) explodes into **parts (零件)**, and every part is tracked **independently** through a fixed pipeline of up to **10 production stations (工序):**

`工程 (engineering/planning) → 编程 (CAM programming) → 操机 (CNC machining) → 检验 (in-process inspection) → 手工 (manual finishing/assembly) → 打磨 (grinding/deburr) → 喷漆 (painting/coating) → 丝印 (silkscreen) → 质量 (final QC) → 出货 (shipping)`

- Each part only runs the **subset of stations it needs** — engineering sets the "route" per part with a chip picker. A simple part might be 工程→操机→质量→出货; a finished part runs all 10.
- Each (part, station) pair is a tracked cell with state **pending → in_progress → done**, who-did-it (by_actor), timestamps (started/finished), and partial-completion quantity (done_qty) so a batch can be half-finished at a station.
- **Floor workers** see only their own station, as a queue: **在此** (ready for me) / **上游** (still upstream) / **下游/已出货** (already past me). They tap ▶ 起步 to start and ✓ 收件 to finish. No spreadsheets, no hunting.
- **The boss/commerce** see the full matrix — every part of every order, exactly which station it's at, what's stuck, what's overdue — on one master board.

This is the thing that was **previously impossible**: 4,200 parts × 9 stations across 36 people, live, on one screen.

**Supporting operational features:**
- **加急 (rush)** flag — floats an order to the top of every view.
- **暂停 (hold)** — independently pause an order (with reason + who), e.g. waiting on customer.
- **图纸变更 (drawing-change alarm)** — customer revised the drawing; system flags the order red until updated files are redistributed.
- **退货 (customer returns)** — re-open specific parts on a returned order and re-route only those, with its own due date override.
- **重点 / 今日重点 (daily focus board)** — boss/commerce curate "what MUST finish today"; everyone sees it read-only.
- **handover (交接)** — shift/role handover notes.

### B. Finance (the money core — "80×" pillar #2)

**The order-money pipeline** — one row per order, read left-to-right like the production board reads left-to-right:

`合同 (contract?) → 金额 (order value) → 外协 (outsourcing spend) → 出货 (shipped?) → 开票 (invoiced) → 回款 (paid) → 应收 (receivable) → 毛利 (gross margin = 金额 − 外协支出)`

- Flags **无合同** (shipped with no contract = margin leak) in red.
- Tracks **应收账款 (accounts receivable)** with 30-day aging → **逾期 (overdue)** flag.
- Per-order **gross margin** computed live (sale − external spend).
- Portfolio KPIs: 订单总额 (total order value), 应收余额 (outstanding receivables), 外协总额 (total outsourcing), 逾期未回款 (overdue unpaid).
- Built for speed: reads 4 small tables, skips the 4,000-row parts table, sub-second even at 10k+ orders.

**Four finance views** (`/finance`):
1. **订单 (Order money)** — the per-order pipeline above (default).
2. **应收 (AR ledger)** — per-shipment invoicing & collections (开票日期/金额, 回款时间/金额, 对接人), overdue tracking.
3. **支出 (Expense ledger)** — 7 manual cash categories: 工资 payroll, 房租 rent, 水电 utilities, 耗材 consumables, 税费 tax, 原材料 raw materials, 日常开支 daily/reimbursement. Has "copy last month's payroll" convenience. **Gated to boss + finance role.**
4. **月度 (Monthly cashflow)** — 回款 income − (manual expenses + outsourcing + procurement) = net cash flow, with category breakdown. **Gated.**

**Per-part pricing:** every part carries unit price + line total (AI-extracted on import, hand-correctable). Unpriced parts are flagged.

### C. Order intake — AI import (the wedge / acquisition magic trick)

- Boss/commerce **drops a customer's raw Excel/PDF** (messy, with embedded part photos) → **Google Gemini (via Vertex AI)** parses it in ~60s into: order header (job no, customer, product, amount, due date), and **every part** (name, qty, material, surface treatment, process, unit price, line total) — **including mapping embedded Excel images to the right part.**
- A human reviews/trims on an import screen, sets part routes, then confirms → order goes live.
- This kills the single most painful, error-prone, hours-long task in the shop (manual data entry of a 200-line order). **This is the demo that makes a boss say "I need this."** (Note: 56 of 817 parses "failed" — extraction isn't perfect, hence the human-review step.)

### D. Outsourcing management (外协)

- Commerce creates an **外协 block**: pick the activity (外发CNC, 外发氧化, 外发电镀, 外发喷塑, 外发线割, 激光焊接 …), the parts + quantities, the vendor (searchable, or create new), per-part prices, sent date, expected return.
- System **auto-generates a printable 外协单 (vendor PO)** as a PDF (strips internal process info the vendor shouldn't see).
- Tracks **partial returns** per part, closes the block when all parts are back, and detects conflicts (same part-stage already out to another vendor).
- All of this feeds the per-order outsourcing spend and the vendor performance history.

### E. Inspection / QC (检验 + 质量)

- In-process **检验** station with four verdicts per part: **OK / 重做 (redo) / 返修 (repair) / 外修 (send out for repair)**. Failing verdicts **block the part** (painted red on the floor) and capture 不良原因 (defect reason) + 责任人 (responsible upstream station) — a permanent audit trail that never auto-clears.
- Inspection **photos** per part.
- **出厂检验报告 (outgoing QC report)** auto-generated as a PDF matching the shop's standard template (dimensions, tolerances, measured values, surface/appearance/packaging checks, signatures).

### F. Procurement (采购)

- Ledger of material/tooling purchases: item, qty, unit price, supplier, order date, expected/actual arrival, buyer, status (采购中 / 已到货).
- Remembers **going prices per item** and stores 1688/Taobao links (a parts catalog that learns the shop's buying patterns). *(Currently lightly used — 3 rows.)*

### G. Documents auto-generated (PDF)

- **外协单** (vendor PO) · **送货单/出货单** (customer delivery note) · **出厂检验报告** (QC report). All branded, Chinese-font, print-ready.

### H. Reporting / analytics

- **/pulse (现场)** — live shop floor: work-in-progress per station in **both ¥ value and part count**, plus a real-time activity feed.
- **/report (报工)** — per-worker output by day/week/month: parts completed **and ¥ value handled** per person (piecework/productivity).
- **/daily (重点)** — the daily must-finish board.
- Master board overdue/alarm indicators, 暂停/取消 columns, etc.

### I. Roles & data visibility

Strict role-based field scrubbing:
- **商务 (commerce, 10 users)** — sees everything: customers, vendors, money, margins. Imports orders, manages outsourcing, invoicing.
- **工程 (engineering head)** — sees customers + routes parts + approves process cards; **no money**.
- **Floor workers (production, 26 users)** — see only their station + job no + product; **no customer, no money**.
- **Finance/boss** — additionally sees the gated expense & monthly-cashflow views.

### J. Process cards (工艺卡)

- Gemini (Pro, with reasoning) reads the **drawings/PDFs** and generates a per-component **process card**: for each of the 10 stages, whether it applies + 3–6 key points + risks, in a shop-floor "老师傅" tone. Helps engineering plan routing and gives workers instructions.

---

## PART 4 — Data model (the tables, so you understand what data exists)

`jobs` (orders) → `parts` (components) → `part_stages` (the (part×station) tracking grid, 39k rows). Plus:
- `outsource_blocks` + `outsource_block_parts` (vendor dispatches, with per-part pricing & returns)
- `vendors` (38), `customers` (85, unnormalized)
- `shipments` + `shipment_parts` + `shipment_finance` (delivery + invoicing/collection)
- `procurements` + `procurement_products` (purchasing + price memory)
- `expenses` (manual cash ledger), `returns` + `return_parts`
- `inspection_reports`, `part_photos`, `process_cards`, `contract_files`
- `users` (36, role + default_stage + is_finance), `daily_focus_items`, `handovers`, `mutation_log` (audit), `master_board_rows` (denormalized read cache)

**Everything is timestamped and attributed** (who did what, when) — there is a full operational audit trail.

---

## PART 5 — The proprietary data moat (why this is more than software)

Because the system sits on the actual flow of work and money, it accumulates data no competitor and no bank has:
1. **Real per-part machining cost & price history** — years of auditable quotes by material/treatment/process. (Most shops quote from memory.)
2. **Vendor performance** — real price, turnaround (dispatch→return), and quality (redo/repair rates) per outsourcing vendor per process.
3. **Material/tooling going-prices** per supplier over time.
4. **Customer behavior** — order frequency, value, and **payment discipline** (days-to-collect, overdue rate) per customer — i.e. a private credit score on blue-chip buyers.
5. **Verified receivables in real time** — invoices + shipment confirmations + payment history. This is underwriting-grade cashflow data.
6. **Live capacity & throughput** — what each station/worker/factory can produce, in ¥/day.

---

## PART 6 — Tech & deployment reality (constraints you should know)

- **Stack:** Next.js 16 (App Router) + React 19 + TypeScript; **Supabase** (Postgres + storage) as the backend; **Gemini via Google Vertex AI** for parsing/process-cards; JWT cookie auth.
- **Hosting:** a **single Alibaba Cloud VM** in Hong Kong (no Vercel, no Docker, no CI). pm2 + Caddy. Deploy = SSH in, git pull, build on the box. SQL migrations are **applied by hand**.
- **Domain:** siyue.ai (primary).
- **Implications:** the company is currently a single-tenant deployment on one VM. Multi-tenant SaaS, scale, billing, onboarding — **none of that infrastructure exists yet.** Going from 1 factory to thousands requires building the multi-tenant/onboarding layer. This is greenfield and a real cost/time line item for any plan.

---

## PART 7 — Channels available (for go-to-market)

- **Geographic clustering:** these shops cluster in 产业带 (industrial belts) — 深圳/东莞 (Pearl River Delta), 苏州/昆山, **宁波/杭州** (where the current customer is). Saturate a cluster, then the next.
- **The 外协 network (multi-sided):** every factory shares vendors; every vendor serves many factories. The 外协单 is currently a printed PDF — making it a digital, two-sided link is a natural viral loop (seed one factory → reach its 38 vendors → reach their other factory customers).
- **WeChat 老板群 (boss groups):** these owners live in industry WeChat groups; a 30-second screen-record of the Excel-import magic trick spreads itself.
- **Customer-of-customer pull:** the auto-generated delivery notes & QC reports go to blue-chip customers (Hikvision et al.), who ask "how did you make this?"
- **Demand-side leverage:** the buyers (Hikvision, Dahua, Scantech, solar/medical firms) are concentrated and powerful — a lever for both distribution and a future demand-routing marketplace.

---

## PART 8 — What is NOT built yet (gaps = your opportunity surface)

- No multi-tenant SaaS / self-serve onboarding / billing.
- No automated quoting engine (pricing is manual; huge latent value given the historical price data).
- No two-sided vendor portal (外协 is one-way PDF today).
- No financing/credit product (despite holding underwriting-grade receivables data).
- No materials/tooling group-buy (despite procurement price data).
- No customer entity-resolution (names are a mess).
- AR/expense/procurement ledgers exist but are barely populated — adoption gap.
- AI is used only for *intake* (parsing) and *process cards*, not yet for *quoting, chasing, or decision automation*.

---

## PART 8.5 — The financing thesis (read this before you sequence revenue)

**Embedded lending / supply-chain finance against verified receivables is, by raw economics, the single largest revenue stream available here — likely ~50–100× the per-customer revenue of any SaaS or AI-labor product.** Do not under-weight it. Do not treat it as a "careful, regulated, maybe-later" footnote. It is the harvest.

**The math, per factory:** a ¥40M-revenue shop carries ~¥5–10M of receivables outstanding at any moment (ships, then waits 30–90 days to collect). Financing that at China SME factoring rates (~1.5%/month ≈ 18%/yr) yields **~¥1–1.8M of interest revenue per factory per year** vs. ~¥10k for a SaaS seat. 100 factories → a ~¥0.5–1B loan book → ~¥90–180M/yr interest; at a ~13% net spread (borrow ~5%, lend ~18%) → **~¥65–130M/yr net cash.** This throws off *cash*, not just equity multiple.

**Why the data moat makes it low-risk (this is the crux):** SME lending normally dies on information asymmetry — you can't tell if a tiny job shop will get paid. This product kills that asymmetry for free: it sees the **order from a blue-chip end-payer** (Hikvision/Dahua/Scantech/listed solar & medical firms), the **shipment confirmation** (出货单), and **historical payment behavior** — and **91–96% of orders are from repeat customers**. So you don't lend against a sketchy factory; you lend against a **confirmed receivable owed by a public company.** Default risk approaches near-zero when financing is restricted to verified invoices from creditworthy buyers. That underwriting edge is the entire game, and this company has it and competitors do not.

**The right structural stance** (corrected — earlier drafts said "never become the bank," which under-sold it): **capture as much of the interest spread as legally possible.** Partner only for the *capital and the license* (a 保理/factoring or 小贷 vehicle, or a funding line from 网商/微众/a bank) — do **not** give the *margin* away to a bank as a thin referral fee unless forced to. The spread is the prize; own it.

**Why software/AI-labor still comes first — sequencing, not preference.** Lending only *prints* (instead of blows up) once you have: (1) **borrower density** — a diversified book across many factories/buyers so one slow payment can't sink you; (2) **the repayment rail** — you must get paid back first, which means inserting the platform into the invoicing/collection flow so repayment routes to you automatically; (3) the **verified-receivable data feed**, which only exists because the factory runs daily ops on the system. The MES + AI-labor layer is how you acquire borrowers, capture the rail, and generate the data — fast (6–12 months) and cheaply. **Plant with software, harvest with lending.** Same company, two moves, in order — not either/or.

**The three real failure modes to engineer around** (operating requirements, not reasons to avoid it): **capital source** (need a funding line/license), **fraud** (factory borrows against a fake or already-paid invoice → control the data + the collection account), and **buyer concentration** (diversify across factories/end-payers). Plan for these explicitly.

> Note on "get rich": if the goal is a high-multiple VC exit, the software platform carries the valuation. If the goal is **maximum ongoing cash wealth** (the owner's stated framing — "extremely rich," "shit ton of money"), **lending is the answer**, because the spread is enormous real cash even at a low valuation multiple. Sequence accordingly; weight the financing layer as the primary profit engine, not a side feature.

---

## PART 9 — Your task

Given all of the above, design the plan to make the owner extremely rich:
- **The constraint to break:** the product is worth ~80× its ¥10k price but is sold as a cheap tool. Find the business model where the software is the wedge/data-layer and the real revenue rides on the **flows it observes** — money (receivables/financing), materials (procurement), outsourcing capacity, and labor (AI automation of quoting/chasing/QC).
- **The growth goal:** saturate the ICP (high-mix small-batch precision job shops) *fast* — pick the channel and the viral/network mechanic that compounds.
- **The revenue goal:** identify and sequence the major revenue streams (think beyond SaaS seats — AI digital-labor priced vs. salaries, embedded supply-chain finance on verified receivables, group procurement, an outsourcing/capacity marketplace, demand routing from the blue-chip buyers). **Weighting is given in Part 8.5: lending is the primary cash engine; treat the others as the path that earns the right to lend (density + repayment rail + data), not as alternatives to it.**
- **Be concrete:** what to build, in what order, who to sell to first, and how the data moat defends each layer.

Everything above is real and current as of 2026-06-20. Build the plan.
