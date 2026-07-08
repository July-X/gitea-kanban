package main

import (
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/store"
)


// ===== v2.4 用户偏好（prefs）=====
//
// 修复 v2.0 stub bug：
//   - 旧版 shim user.prefs.{get,set} 是 notImplemented → StatusBar 选完仓库重启后
//     "应用没记住" 的根因之一（虽然 localStorage 兜底能恢复，但 IPC 路径死链）
//   - 新版：写 localStore.Prefs（与 AGENTS §6.4 业务态"应用偏好"对齐）
//   - frontend 不需要知道细节，shim 转发即可

// GetUserPrefsArgs 读取偏好参数（v2.4 · 不能用匿名 struct，Wails 生成 TS 会坏）
type GetUserPrefsArgs struct {
	Keys []string `json:"keys"`
}

// GetUserPrefs 读取指定 keys 的偏好值
//
// 请求：{ keys: string[] }
// 返：{ "key1": value1, "key2": value2 }（不存在的 key 不会出现在返回里）
func (a *App) GetUserPrefs(args GetUserPrefsArgs) (map[string]any, error) {
	if a.localStore == nil {
		return nil, ipc.NewInternal("localStore 未初始化")
	}
	state := a.localStore.Get()
	if state.Prefs == nil {
		return map[string]any{}, nil
	}

	out := make(map[string]any, len(args.Keys))
	if len(args.Keys) == 0 {
		// 没指定 keys → 返全部
		for k, v := range state.Prefs {
			out[k] = v
		}
		return out, nil
	}
	for _, k := range args.Keys {
		if v, ok := state.Prefs[k]; ok {
			out[k] = v
		}
	}
	if a.logger != nil && len(args.Keys) > 0 && len(args.Keys) < 20 {
		a.logger.Info("GetUserPrefs", "keys", args.Keys, "found", len(out))
	}
	return out, nil
}

// SetUserPrefsArgs 写入偏好参数（v2.4 · 不能用匿名 struct，Wails 生成 TS 会坏）
type SetUserPrefsArgs struct {
	Entries map[string]any `json:"entries"`
}

// SetUserPrefs 写入偏好（merge 到现有 Prefs，不存在键才加，null 删键）
//
// 请求：{ entries: { "key1": value1, "key2": null, ... } }
// 返：{ written: int, deleted: int }
//
// 语义：
//   - value != null → 写入
//   - value == null → 删除该 key
func (a *App) SetUserPrefs(args SetUserPrefsArgs) (map[string]any, error) {
	if a.localStore == nil {
		return nil, ipc.NewInternal("localStore 未初始化")
	}
	if args.Entries == nil {
		return map[string]any{"written": 0, "deleted": 0}, nil
	}

	written := 0
	deleted := 0
	err := a.localStore.Mutate(func(s *store.LocalState) {
		if s.Prefs == nil {
			s.Prefs = map[string]any{}
		}
		for k, v := range args.Entries {
			if v == nil {
				delete(s.Prefs, k)
				deleted++
			} else {
				s.Prefs[k] = v
				written++
			}
		}
	})
	if err != nil {
		return nil, ipc.NewInternal("保存 prefs 失败: " + err.Error())
	}

	if a.logger != nil {
		a.logger.Info("SetUserPrefs", "written", written, "deleted", deleted)
	}
	return map[string]any{"written": written, "deleted": deleted}, nil
}
