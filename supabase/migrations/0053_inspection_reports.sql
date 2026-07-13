-- 出厂检验报告 (outgoing QC report) — the shop's standard QR0707-004 Excel
-- template, attached at the 质量 step ("质量增加标准检验模板").
--
-- One report per part. Header facts (订单编号/客户/零件/材料/表面处理/发货数)
-- are NOT stored — they're computed from the job/part at render time so the
-- report never drifts from an edited part. Only the inspector's hand-filled
-- sections persist, as JSONB blobs mirroring the template's areas:
--   dims            [{label,nominal,unit,tolUp,tolDown,measured,verdict,gauge}]
--   process_checks  ticked items: 氧化/钝化/电镀/电泳/背胶/贴膜/线割/焊接/
--                   攻牙/牙套/抛光/镭雕/喷漆/染色
--   performance     涂层附着力/丝印耐醇性/丝印附着力/螺母通止规/其他项
--   appearance      色差实测(⊿E≤1.5)/外观缺陷/不良描述
--   packaging       打包方式/外箱外观/外箱标识/随货文件

create table if not exists inspection_reports (
  id             text primary key,            -- uid('qr')
  part_id        text not null references parts(id) on delete cascade,
  report_no      text,                        -- 报告编号 (QR…), editable
  inspect_method text,                        -- 检验方法
  dims           jsonb not null default '[]',
  process_checks jsonb not null default '[]',
  performance    jsonb not null default '{}',
  appearance     jsonb not null default '{}',
  packaging      jsonb not null default '{}',
  disposition    text,                        -- 本批次产品处理方案
  customer_plan  text,                        -- 客户沟通后处理方案
  final_verdict  text,                        -- 最终判定结果
  evaluation     text,                        -- 评估处理结果
  confirmer      text,                        -- 确认人
  inspector      text,                        -- 质检员
  approver       text,                        -- 审核/批准
  inspected_at   date,                        -- 检验时间
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     text
);

-- One report per part — the editable print page upserts against this.
create unique index if not exists inspection_reports_part_uniq
  on inspection_reports (part_id);
