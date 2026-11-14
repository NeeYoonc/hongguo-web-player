import { signHongguoRequest } from "./danmu_api/sources/hongguo.js";
import { md5 } from "./danmu_api/utils/codec-util.js";
import fs from "node:fs";

const [vid, sid, start, dur, cookieFile, cursor] = process.argv.slice(2);
const login = JSON.parse(fs.readFileSync(cookieFile, "utf8"));
const cookies = login.cookies || {};
const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
const token = login.token || "";

const url = `https://api5-normal-sinfonlineb.fqnovel.com/novel/commentapi/comment/list/${vid}/v1/?aid=8662&device_id=${login.device && login.device.deviceId || "2943870484354860"}&iid=${login.device && login.device.installId || "2943870484358956"}&channel=xiaomi_8662_64&device_platform=android&app_name=novelread&version_code=73932&device_type=23127PN0CC&os=android&os_api=34&os_version=14`;
const body = {
  comment_source: 601, server_channel: 1000, group_id: vid, group_type: 30,
  comment_type: 20, sort: 1, count: 100, cursor: cursor || "", aid: 8662,
  business_param: { book_id: sid, start_offset_time: Number(start) || 0, playlet_item_duration: Number(dur) || 30000 },
};
const raw = JSON.stringify(body);
const stub = md5(Buffer.from(raw)).toUpperCase();
const sig = signHongguoRequest(url, { headers: { "x-ss-stub": stub } });
const res = await fetch(url, {
  method: "POST",
  headers: {
    ...sig, "x-ss-stub": stub, cookie, "x-tt-token": token,
    "user-agent": "com.phoenix.read/73932", "content-type": "application/json; charset=utf-8",
    "comment-source": "601", "server-channel": "1000",
  },
  body: raw,
});
const text = await res.text();
process.stdout.write(text);
