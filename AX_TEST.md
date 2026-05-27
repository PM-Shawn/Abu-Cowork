# AX Step 2 验证脚本

## 前提

1. `npm run tauri:dev` 已跑起来
2. 备忘录已打开（没有就先跑 `open -a Notes`）
3. 已授权辅助功能权限

---

## 测试代码（devtools Console）

粘贴以下代码 → 按 Enter → **3 秒内点击备忘录窗口**

```js
console.log('⏳ 3 秒内请切换到「备忘录」...');
setTimeout(async () => {
  try {
    const snap = await window.__TAURI__.core.invoke('ax_snapshot');
    console.log(`✅ 快照: ${snap.app}  ${snap.elements.length} 个元素`);
    console.log('session_id:', snap.session_id);

    const newBtn = snap.elements.find(e =>
      e.role === 'AXButton' && e.actions.includes('AXPress')
    );
    if (newBtn) {
      console.log(`▶ ax_press → [${newBtn.id}] "${newBtn.label ?? '—'}"`);
      await window.__TAURI__.core.invoke('ax_press', {
        sessionId: snap.session_id,
        elementId: newBtn.id
      });
      console.log('✅ ax_press 成功');
    }

    await new Promise(r => setTimeout(r, 600));

    const ta = snap.elements.find(e => e.role === 'AXTextArea');
    if (ta) {
      const txt = `阿布 AX 无光标写字 ${new Date().toLocaleTimeString()}`;
      console.log(`▶ ax_set_value → [${ta.id}] "${txt}"`);
      await window.__TAURI__.core.invoke('ax_set_value', {
        sessionId: snap.session_id,
        elementId: ta.id,
        text: txt
      });
      console.log('✅ ax_set_value 成功');
    }

    await window.__TAURI__.core.invoke('ax_close_session', {
      sessionId: snap.session_id
    });
    console.log('✅ session 已关闭');
  } catch (e) {
    console.error('❌', e);
  }
}, 3000);
```

---

## 预期效果

- 备忘录触发一次按钮动作（如新建备忘录）
- 文字直接出现在编辑区，**鼠标不动、键盘没声音**
- console 全绿 ✅

---

## 如果报错

| 错误信息 | 原因 | 解决 |
|---------|------|------|
| `Session not found` | 忘记先调 ax_snapshot | 重新跑完整代码 |
| `kAXErrorActionUnsupported (-25206)` | 该元素不支持 AXPress | 换一个有 AXPress action 的元素 |
| `kAXErrorInvalidUIElement (-25202)` | 元素已失效（窗口关了） | 重新 ax_snapshot |
| `需要辅助功能权限` | TCC 没授权 | 系统设置 → 辅助功能 → 开启 abu |
