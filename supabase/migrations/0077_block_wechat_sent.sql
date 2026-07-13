-- 0077: 外协单 WeChat-notify stamp.
--
-- The vendor-portal growth loop dies if the 外协员 never sends the WeChat
-- message — and today "sent" isn't a state, so nothing ever looks unfinished
-- when she skips it. This column makes "告诉厂商" a first-class lifecycle step:
-- stamped when the share message is copied, cleared never. Rows without it
-- (and without vendor_seen_at proving the vendor got there anyway) render as
-- an amber 待发微信 cell on the job tab and the 外协台.

alter table outsource_blocks
  add column if not exists wechat_sent_at timestamptz;
