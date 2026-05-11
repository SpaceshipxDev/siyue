-- 加急 outsourcing. A rush block ships before the vendor has quoted, so
-- amount_cny is unknown at create time. Make it nullable, and add an
-- is_rush flag so the UI can surface 加急 + 待补金额 chips and so the
-- printed 外协单 can render 金额 = "—" instead of ¥0 until commerce
-- backfills the price.

alter table outsource_blocks
  add column if not exists is_rush boolean not null default false;

alter table outsource_blocks
  alter column amount_cny drop not null;
