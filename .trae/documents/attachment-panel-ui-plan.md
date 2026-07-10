# Attachment Panel UI — Plan (v0.5.0-pre.18)

## 摘要

在卡片弹窗（`CardModal`）里补一个"Attachments"区域，把 `card.attachments[]` 数据结构可视化。这是 pre.16 attachment rework 的收尾——同步逻辑已就绪，缺一个让用户看得见的 UI 面板。

**工程量：小到中等，pre.18 可完成**。单文件改动为主（`modals.js` + `styles.css`），无需触碰同步层。

## Phase 1: 现状分析

### 数据结构已就绪（pre.16）

`card.attachments[]` 每条元素：
```js
{
  remoteId,    // Deck attachment id
  fileid,      // Nextcloud Files fileid（用于构建 preview url）
  filePath,    // Vault-relative path，如 "Deck/Welcome/attachments/card-x/foo.png"
  filename,    // "foo.png"
  remoteUpdatedAt,
  contentType, // "image/png" 等
}
```

同步逻辑：pushCard / pullCard / reap 都在 [attachment-sync.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/attachment-sync.js) 已工作。

### 删除通路已就绪

Obsidian vault 的 `delete` 事件在 [plugin.js#L67](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js#L67) 已注册：
- 用户/UI 通过 `app.vault.trash(file)` 删本地文件
- [handleAttachmentDelete](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/plugin.js#L496) 从 `card.attachments` 移除 + 加入 pendingAttachmentDeletions
- 下次 sync 时 [AttachmentSyncer.reap](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/attachment-sync.js) 走 OCS DELETE

**结论**：UI 侧不需要重复实现删除逻辑，只要触发 `trash()`。

### CardModal 结构（[modals.js#L662](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/modals.js#L662)）

Modal 主体渲染在 `onOpen()` 里，通过 `this.contentEl.append(title, labelsField, detailsField, checklistField, actions)`。可插入新 field，模式与 `renderLabelsField` / `renderDetailsField` 一致。

有一个已存在的样式 `.ot-image-gallery`（[styles.css#L1337](file:///Users/victorsmith/Documents/trae_projects/task-deck/styles.css#L1337)）用来在 detailsField 里显示缩略图——**这是 details 里 `![[…]]` 的预览渲染**，不适合直接复用当"附件面板"（会随 details 编辑状态切换）。新建一个独立组件更清晰。

### insertImageFromFile 已存在（[modals.js#L1300](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/modals.js#L1300)）

已经能把文件保存到 `<board>/attachments/<cardId>/` 并插入 `![[…]]`。**"+ Add attachment"按钮直接复用它**，不再需要单独实现上传。

## Phase 2: 决策

**面板行为**：只读列表 + 少量交互，不是一个全功能文件浏览器。

具体功能：

| 功能 | 是否做 | 说明 |
| --- | --- | --- |
| 显示 attachments 列表 | ✅ | filename + 缩略图 |
| 点击缩略图打开文件 | ✅ | `app.workspace.openLinkText` |
| 删除按钮 | ✅ | `app.vault.trash(file)`，剩下的同步层处理 |
| "+ Add attachment" 按钮 | ✅ | 复用 `insertImageFromFile`（也会同时插入 `![[…]]` 到 details） |
| 手动上传"不插入 details" | ❌ | 违背方案 1 心智模型（图应内嵌） |
| 拖拽排序 | ❌ | 附件在 Deck 端没有 order 概念 |
| 批量删除 | ❌ | 附件通常个位数 |
| 显示 Deck-only 附件（本地 details 没引用） | ✅ | 这些是 pull 下来的孤儿，正好用面板处理 |
| 修改文件名 | ❌ | 走 vault rename 事件已经能处理 |

**折叠行为**：默认展开若有 ≥1 附件；无附件时显示提示行 "No attachments"。

## Phase 3: 变更清单

### 1) `src/modals.js`

**新增方法** `renderAttachmentsField()`（位置：紧跟在 `renderDetailsField()` 后）：

```js
renderAttachmentsField() {
  const field = createElement("section", "ot-field ot-attachments-field");
  const header = createElement("div", "ot-attachments-heading");
  const icon = createElement("span", "ot-attachments-icon");
  try { setIcon(icon, "paperclip"); } catch {}
  const title = createElement("span", "", "Attachments");
  const count = createElement("span", "ot-attachments-count", "");
  const addBtn = iconButton("plus", "Add attachment", () => this.triggerAttachmentUpload());
  header.append(icon, title, count, addBtn);

  const list = createElement("div", "ot-attachments-list");

  const render = () => {
    list.replaceChildren();
    const items = Array.isArray(this.card.attachments) ? this.card.attachments : [];
    count.textContent = items.length ? `(${items.length})` : "";
    if (!items.length) {
      list.append(createElement("div", "ot-attachments-empty", "No attachments"));
      return;
    }
    for (const att of items) {
      const tile = this.buildAttachmentTile(att, render);
      list.append(tile);
    }
  };

  this.attachmentsRefresh = render;
  render();
  field.append(header, list);
  return field;
}

buildAttachmentTile(attachment, onRefresh) {
  const tile = createElement("div", "ot-attachment-tile");
  const file = this.app.vault.getAbstractFileByPath(attachment.filePath);
  const isImage = /^image\//i.test(attachment.contentType || "");

  const thumb = createElement("div", "ot-attachment-thumb");
  if (file && isImage) {
    const img = createElement("img", "");
    img.src = this.app.vault.getResourcePath(file);
    img.alt = attachment.filename;
    thumb.append(img);
  } else {
    const icon = createElement("span", "ot-attachment-icon");
    try { setIcon(icon, isImage ? "image" : "file"); } catch {}
    thumb.append(icon);
  }

  const meta = createElement("div", "ot-attachment-meta");
  const name = createElement("div", "ot-attachment-name", attachment.filename || "unnamed");
  meta.append(name);

  const openBtn = iconButton("external-link", "Open", () => {
    if (file) this.app.workspace.getLeaf(true).openFile(file);
  });
  const delBtn = iconButton("trash", "Delete", async () => {
    if (!window.confirm(`Remove "${attachment.filename}"? The linked file will be moved to trash.`)) return;
    if (file) {
      try { await this.app.vault.trash(file, true); }
      catch (e) { new Notice(`Delete failed: ${e.message || e}`); return; }
    } else {
      // File missing already; still drop the entry from card.attachments.
      const idx = (this.card.attachments || []).indexOf(attachment);
      if (idx >= 0) this.card.attachments.splice(idx, 1);
    }
    this.plugin.markCardDirty(this.card);
    await this.plugin.saveData(this.plugin.data);
    onRefresh();
  });

  const actions = createElement("div", "ot-attachment-actions");
  actions.append(openBtn, delBtn);

  tile.append(thumb, meta, actions);
  return tile;
}

triggerAttachmentUpload() {
  // Reuse the existing hidden input UX from renderDetailsField if
  // possible; simpler to create a fresh one that only opens once.
  const input = createElement("input", "ot-hidden-file-input");
  input.type = "file";
  input.multiple = true;
  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    for (const f of files) await this.insertImageFromFile(f);
    if (this.attachmentsRefresh) this.attachmentsRefresh();
  });
  input.click();
}
```

**在 `onOpen`（[modals.js#L740](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/modals.js#L740)）里挂载**：

```diff
- const labelsField = this.renderLabelsField();
- const detailsField = this.renderDetailsField();
- const checklistField = this.renderChecklistField();
+ const labelsField = this.renderLabelsField();
+ const detailsField = this.renderDetailsField();
+ const attachmentsField = this.renderAttachmentsField();
+ const checklistField = this.renderChecklistField();
...
- this.contentEl.append(title, labelsField, detailsField, checklistField, actions);
+ this.contentEl.append(title, labelsField, detailsField, attachmentsField, checklistField, actions);
```

**在 `insertImageFromFile` 结尾 refresh 面板**（[modals.js#L1300+](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/modals.js#L1300)）：
```diff
  await this.app.vault.createBinary(targetPath, data);
  const inserted = this.insertDetailText(`![[${targetPath}]]`);
  ...
+ if (this.attachmentsRefresh) this.attachmentsRefresh();
```

注意：`insertImageFromFile` 只写文件 + 插 wikilink，**不**主动往 `card.attachments[]` 加条目——那由下次 sync 的 `attachments.pushCard` 扫描时补齐。所以面板首次刷新可能"没看到新文件"，直到下次 sync。**改进**：面板 render 除了看 `card.attachments[]`，也扫 `<board>/attachments/<cardId>/` 目录，把只在本地存在的"未同步文件"也显示出来（标记为 "pending upload"）。

### 2) `src/styles.css`

新增样式约 60 行：

```css
.ot-attachments-field { ... }
.ot-attachments-heading { display: flex; align-items: center; gap: 6px; }
.ot-attachments-count { color: var(--text-muted); font-size: 0.85em; }
.ot-attachments-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin-top: 8px; }
.ot-attachments-empty { color: var(--text-muted); padding: 8px; text-align: center; }
.ot-attachment-tile { display: flex; flex-direction: column; border: 1px solid var(--background-modifier-border); border-radius: 6px; overflow: hidden; }
.ot-attachment-thumb { aspect-ratio: 16/10; display: flex; align-items: center; justify-content: center; background: var(--background-secondary); }
.ot-attachment-thumb img { max-width: 100%; max-height: 100%; object-fit: cover; }
.ot-attachment-icon { font-size: 32px; color: var(--text-muted); }
.ot-attachment-meta { padding: 6px 8px; }
.ot-attachment-name { font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ot-attachment-actions { display: flex; justify-content: flex-end; gap: 4px; padding: 4px 6px; border-top: 1px solid var(--background-modifier-border); }
```

## Phase 4: 验证步骤

1. 打开有附件的卡片 → 应看到 "Attachments" 区域，缩略图 + 文件名
2. 点击缩略图 → Obsidian 打开该图片文件在新 tab
3. 点垃圾桶 → 确认 → 文件移至 trash，面板刷新，sync 后 Deck 端也删掉
4. 点 "+" → 选文件 → 上传成功、details 里插入 `![[…]]`、面板出现新 tile
5. 云端加个附件（Web UI）→ sync now → 面板出现新 tile（pull 下来的）
6. 无附件卡片 → 面板显示 "No attachments"
7. 现有 24 个单元测试 **不受影响**（本次改动纯 UI）

## 工程量评估

| 项目 | 大小 |
| --- | --- |
| `modals.js` 新增 3 个方法 | ~120 行 |
| `modals.js` 修改 onOpen + insertImageFromFile | ~5 行 |
| `styles.css` 新增 | ~60 行 |
| 手动测试 | 6 个场景 |

**总计**：单文件为主、无 API 变更、无同步逻辑改动、单元测试不受影响。**pre.18 内可完成**。

## 假设 & 决策

- 复用 `insertImageFromFile` 而非另起 upload flow —— 保持"图片在正文内"的方案 1 心智模型
- 删除走 vault trash（触发已有的 handleAttachmentDelete）—— 避免重复实现同步侧的删除队列
- 缩略图用 `app.vault.getResourcePath(file)` —— Obsidian 原生方式加载本地文件
- 面板不显示非图片附件的缩略图 —— 只显示 file icon（Deck 通常也是图为主）
- **待同步文件** vs **已同步 attachment**：合并两个来源（`card.attachments[]` + 目录扫描）显示为一个统一列表，但不区分状态（避免视觉噪音）。用户下次 sync 就自动同步。
