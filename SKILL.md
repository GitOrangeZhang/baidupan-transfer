---
name: baidupan-transfer
version: 1.1.0
description: 百度网盘分享批量转存工具。自动递归统计分享目录的真实文件数（页面显示的"N个文件"只是当层条目数，不可信），按账号单次转存上限装箱拆成多批，逐批转存并校验落盘，支持目录结构还原与断点续跑。当用户遇到"转存提示文件过多""超过转存上限""分享文件太多保存不下来""批量保存分享链接"时使用。
metadata:
  emoji: "☁️"
  requires:
    bins: ["node"]
---

# 百度网盘分批转存

## 适用与边界

**能解决**：分享内文件总数远超账号单次转存上限时，自动拆成多批完成转存，并保持原目录结构。

**不能解决**：单次上限本身。它是账号权益，不是工具能力：

| 账号档位 | 单次转存文件数 |
|---|---|
| 非会员 | 500 |
| 会员（VIP/工作/娱乐套餐） | 3000 |
| SVIP V1 | 50000 |
| SVIP V10 | 300000 |

如果用户要求"绕过上限"，明确拒绝并说明这是账号权益限制，只能分批或升级。

## 核心事实（经验结论，务必遵守）

1. **页面上的「N个文件」是当层条目数，不是文件数。** 它只统计当前层级有多少个子项，与真实文件总量可能相差几十倍。所有判断必须基于递归统计。
2. **转存按递归文件数校验**，涵盖所有子层级。超限时返回 `errno: 12`，响应体含 `non_vip_limit`（当前账号上限）与 `target_file_nums`（服务器视角的计数）。
3. **服务器计数会略高于本地递归统计**（常见偏高几个百分点），原因是分享中被过滤或已失效的条目仍参与计数。**装箱上限不要贴着权益上限用，建议取权益上限的 80%**（如 500 → 400）。
4. **分享页文件列表默认全选**，做任何勾选前必须先清空。
5. **列表表头的全选复选框行为不稳定**（点击后状态会跳变），不要依赖表头，逐行操作行内 `.wp-checkbox`。
6. **保存目标目录的树形弹窗有遮罩层拦截**，程序化点击极易失败。优先用页面自身的转存接口指定 `path` 参数（见第 4 步）。
7. **前端框架（Vue/React）的输入框必须用真实输入事件**（fill + Enter），JS 直接赋值 `input.value` 不会触发更新；部分按钮同样对 JS `.click()` 不响应，需要真实鼠标事件。
8. 重名时默认生成 `xxx(1)` 副本（`ondup=newcopy`），不会覆盖已有文件。
9. 分享可能存在「部分文件违规，已被过滤」的提示，执行前先确认源是否完整。
10. **纯文件目录（某一层只有文件、没有子目录）只能做文件级拆批**：按名称排序后等分，`fsidlist` 支持一次提交数百个 fsid。

## 执行流程

### 第 1 步：登录

在浏览器中打开 `https://pan.baidu.com`，请用户在网盘 App 内扫码登录。

> 二维码若经聊天/消息通道传输，部分平台会叠加水印、压缩或改色导致无法识别。优先让用户直接看浏览器窗口扫码；如需传输图片，保存页面原始图片字节为本地文件，避免截屏重编码。

### 第 2 步：递归统计（在分享页上下文执行）

打开分享链接（含 `?pwd=` 提取码），在页面控制台/自动化上下文中执行：

```js
// 返回 { total, items:[{name,type,files}] }
(async () => {
  const y = window.yunData;
  const shareid = y.shareid, uk = y.share_uk || y.uk;
  const base = '/分享根目录';                 // 改成实际待统计路径
  const listAll = async (dir) => {
    let out = [], page = 1;
    while (page <= 20) {
      const u = `/share/list?shareid=${shareid}&uk=${uk}&dir=${encodeURIComponent(dir)}&page=${page}&num=100&order=name&desc=0&showempty=0&web=1&app_id=250528&channel=chunlei&clienttype=0&t=${Date.now()}`;
      const arr = (await (await fetch(u, { credentials: 'include' })).json()).list || [];
      out = out.concat(arr);
      if (arr.length < 100) break;
      page++;
    }
    return out;
  };
  const countDir = async (dir) => {
    let f = 0;
    const walk = async (d) => {
      for (const it of await listAll(d)) {
        if (it.isdir) await walk(d + '/' + it.server_filename); else f++;
      }
    };
    await walk(dir);
    return f;
  };
  const top = await listAll(base);
  const items = [];
  for (const it of top) {
    items.push({
      name: it.server_filename,
      type: it.isdir ? 'dir' : 'file',
      files: it.isdir ? await countDir(base + '/' + it.server_filename) : 1,
    });
  }
  return { total: items.reduce((a, b) => a + b.files, 0), items };
})()
```

要点：

- **必须循环分页**：`num=100` 是服务端单页上限，只取第一页会把 100 条以上条目算少。
- 若 `/share/list` 对根目录返回 `errno: 2`，先读 `window.yunData.file_list` 拿根层条目，再从下一层开始列。

### 第 3 步：装箱

```bash
node scripts/pack.js '<items JSON>' [--limit 400]
```

或直接调用 `packBatches(items, limit)`。规则：大项优先、整目录不拆开、每批累计不超过 limit。

- `limit` 取账号单次上限的 80%（非会员 500 → 用 400）。
- 输出中的 `needSplit` 是自身就超过 limit 的项，必须进入该目录重复第 2 步，对其子项装箱（逐层下钻，直到子项可装箱或只剩纯文件层）。

### 第 4 步：API 转存（推荐）

页面点击保存时调用的就是 `/share/transfer` 接口，参数中带目标目录 `path`。直接复用该接口可以精确控制每批落地位置，并彻底避开目录选择弹窗的交互问题。**该接口由服务端强制校验账号限额，与手动点击完全等价，不存在绕过。**

先在页面上真实点一次保存（选中一个必然超限的大目录触发失败即可），在 network 面板捕获请求 URL 与参数，然后套用：

```js
// 建目录（目标目录必须先存在）
const mk = async (path) => {
  const bd = window.yunData.bdstoken;
  const u = `https://pan.baidu.com/api/create?a=commit&channel=chunlei&bdstoken=${bd}&app_id=250528&web=1&clienttype=0`;
  const body = `path=${encodeURIComponent(path)}&isdir=1&size=&block_list=${encodeURIComponent('[]')}&method=post&dataType=json`;
  const r = await fetch(u, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  return await r.json();
};

// 转存：errno 0 成功，errno 12 超限
const transfer = async (fsids, target) => {
  const y = window.yunData;
  const u = `https://pan.baidu.com/share/transfer?shareid=${y.shareid}&from=${y.share_uk}&sekey=${encodeURIComponent('<从捕获的请求 URL 复制>')}&ondup=newcopy&async=1&channel=chunlei&web=1&app_id=250528&bdstoken=${y.bdstoken}&clienttype=0`;
  const body = `fsidlist=${encodeURIComponent(JSON.stringify(fsids))}&path=${encodeURIComponent(target)}`;
  const r = await fetch(u, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  return await r.json();
};
```

关键点：

- `fsidlist` 是**字符串数组**（如 `["123456789"]`），fsid 取自 `/share/list` 返回的 `fs_id` 字段。
- 按名称匹配 fsid 时，`server_filename` 可能包含不可见字符导致精确匹配失败。命中失败时改用 `includes()` 关键字搜索，不要逐字比对。
- `path` 为网盘绝对路径，**目标目录必须已存在**（先 `mk`）。
- `sekey`、`bdstoken` 等参数从页面捕获值或 `window.yunData` 获取，不要写死。
- 响应 `extra.list[].to` 给出实际落地路径，可逐批核对。
- `errno: 12` 时对失败批二分后重试；若单个目录项独享一批仍超限，说明该目录自身过大，需下钻其子项。
- 单批文件数达到数百时，服务端可能转为异步处理，响应 `msg` 提示"文件转存中"，需延迟 10–15 秒后通过第 6 步校验。
- 批间隔保持 1 秒以上，避免触发风控。

**目录结构还原（逐层容器法）**：凡递归数超过 limit 需要下钻的目录，先在网盘目标位置预建同名容器目录（`mk`），再从分享中该目录的子层选子项转存进容器；子项若自身超限则继续往下一层。纯文件层按名称排序等分提交。

### 第 5 步：UI 点击转存（备用）

无法复用接口时的退路。对每一批：

1. 导航到该批条目的**共同父目录**（分享 URL 的 hash 路径）。
2. 清空选择：遍历 `dd.JS-list-view-item`，把 `aria-checked="true"` 的行内 `.wp-checkbox` 逐个点击。
3. 勾选本批条目：按 `a.filename` 文本匹配，点对应行的 `.wp-checkbox`。
4. 校验「已选 N 个文件/文件夹」与本批条目数一致。
5. 点击 `button.bottom_save_btn`（直接保存到"最近保存路径"，不弹窗）。
6. 等待 4–5 秒读取提示：
   - `保存成功 … 已保存至 【 … 】` → 成功
   - `转存文件数已超限` / `文件过多无法转存` → 减小 limit 重算该批
   - 弹出会员推广浮层 → 关闭后重试一次
7. 目标目录只能在保存前通过底部「最近保存路径」弹窗调整，该弹窗遮罩会拦截自动化点击，需用户手动点选一次。

### 第 6 步：校验落盘

```js
// 列目录
await (await fetch(`/api/list?order=name&desc=0&showempty=1&page=1&num=100&dir=${encodeURIComponent('/目标目录')}&t=${Date.now()}&channel=chunlei&web=1&app_id=250528&bdstoken=`, { credentials: 'include' })).json()

// 按名称搜索（含递归）
await (await fetch(`/api/search?key=${encodeURIComponent('关键词')}&dir=%2F&recursion=1&page=1&t=${Date.now()}&channel=chunlei&web=1&app_id=250528&bdstoken=`, { credentials: 'include' })).json()
```

对目标目录做一次递归统计，与源统计逐层比对，总数与各顶层项一致才算完成。

### 第 7 步：断点续跑

维护状态文件（如 `state.json`），记录每批的条目、文件数、状态：

```json
{
  "share": "https://pan.baidu.com/s/xxxx?pwd=xxxx",
  "base": "/分享根目录/子目录",
  "target": "/目标目录",
  "limit": 400,
  "batches": [
    { "index": 1, "items": ["目录A", "目录B"], "files": 380, "status": "done", "at": "2026-01-01T10:00:00+08:00" },
    { "index": 2, "items": ["目录C"], "files": 240, "status": "pending" }
  ]
}
```

只执行 `status != done` 的批次。重跑前先确认目标目录是否已存在同名项，避免产生 `(1)` 副本。

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 提示「文件过多无法转存」但页面只显示十几项 | 递归文件数超上限 | 按递归数重新装箱 |
| 勾选数量对不上 | 表头全选状态残留 | 逐行清空后再勾 |
| 保存成功但目标目录为空 | 保存路径仍是默认目录 | API 转存用 path 参数；或先手动选定目标目录 |
| 出现 `xxx(1)` | 重复转存 | 先校验再转，或清理副本 |
| 二维码扫不出来 | 图片被水印/压缩破坏 | 直接看浏览器窗口扫码，或用原始图片文件 |
| 目录树无法点击 | 遮罩层拦截 | 改用 API 转存（第 4 步） |
| errno 12，但本地计数明显低于上限 | 服务器计数偏高 | 下调 limit 至上限的 80%，失败批二分重试 |
| 响应提示「文件转存中」 | 大批量异步处理 | 延迟 10–15 秒后校验落盘 |
| 删除接口返回 errno 2 | 参数或场景限制 | 改走 UI：勾选 → 删除 → 确认（按钮需真实鼠标事件） |
| 名称完全相同却匹配不到 fsid | 文件名含不可见字符 | 用 `includes()` 关键字搜索 |
| `/share/list` 根目录 errno 2 | 该分享根层不可直接列 | 读 `window.yunData.file_list` 取根项，从其下一层开始 |

## 安全与合规

- 仅操作用户本人授权的账号，只通过扫码登录，不索取账号密码；登录态保留在本地浏览器 profile，不上传。
- 所有转存、建目录请求与网页界面自身发起的请求一致，由服务端强制校验账号权益，**不绕过任何限额**。
- 删除、覆盖用户网盘已有文件前必须获得用户明确确认；临时文件优先移入回收站。
- 使用本工具需遵守百度网盘用户协议，只转存用户有权获取的内容。