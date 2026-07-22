export const GITHUB_CLI_INSTALL_URL = 'https://cli.github.com/';

export const GITHUB_CLI_REQUIRED_MESSAGE = '同步 GitHub 仓库需要 GitHub CLI（gh）';

export const GITHUB_CLI_REQUIRED_HINT = '用于快速同步提交记录，认证仍使用上方填写的令牌。';

export const GITHUB_CLI_INSTALL_LABEL = '前往安装页';

/**
 * 构建 gh_not_installed 错误专用的 toast 配置（带"打开安装页"按钮）
 *
 * v0.7.20：sync 失败时 catch 到 gh_not_installed 错误码，走此 helper 生成带 actions 的 toast。
 * Toast.vue 已支持 actions 按钮，无需改组件。
 *
 * @param messageText 主消息文本（来自 IpcError.message）
 * @param hint 提示文本（来自 IpcError.hint，可选）
 */
export function buildGhInstallToastError(messageText?: string, hint?: string): {
  type: 'error';
  message: string;
  description: string;
  persistent: boolean;
  actions: { label: string; onClick: () => void; variant: 'primary' }[];
} {
  return {
    type: 'error',
    message: messageText ?? '同步失败：未安装 GitHub CLI（gh）',
    description: hint ?? '请先安装 gh CLI 后再同步 GitHub 仓库',
    persistent: true,
    actions: [
      {
        label: GITHUB_CLI_INSTALL_LABEL,
        onClick: () => window.open(GITHUB_CLI_INSTALL_URL, '_blank'),
        variant: 'primary',
      },
    ],
  };
}

