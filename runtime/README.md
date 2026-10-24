# runtime/

把 `node.exe` 放在这里，这个文件夹就变成**完全免安装**的便携版。

## 怎么用

1. 双击项目根目录的 `make-portable.bat`，它会自动把本机的 `node.exe` 复制到 `runtime\node.exe`。
2. 手动做也行：自己找一个 `node.exe`（Node.js 18 以上）拷进来即可。

## 为什么要它

`start-silent.vbs` / `autostart-daily-ledger.vbs` 找 `node.exe` 的顺序是：

1. `<项目目录>\runtime\node.exe` ← 这里
2. `where node` 的结果（机器上正常装了 Node.js）
3. `%ProgramFiles%\nodejs\node.exe`

放在这里的优先级最高。因此把整个 `daily-ledger` 文件夹打包发给别人时，对方机器上
**不需要装 Node.js**，解压后双击 `start.bat` 就能跑。

## 注意

- `node.exe` 大约 90 MB，已被 `.gitignore` 排除（`runtime/node.exe`），不会进仓库。
- 想改回用系统 Node.js，删掉 `runtime\node.exe` 即可，脚本会自动回退。
- 这个目录本身是空的（只有本说明文件），分发给别人时留着无害。
