' 启动 GLM 的两个后台服务（隐藏窗口，不是任何控制台的子进程）。
' 用法：wscript.exe H:\GLM\group-chat\services.vbs
' 由 DSH 插件或手动调用都可以；已起时重复调用只会多一个失败进程，无害。
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c ""H:\GLM\agent\start-local-glm.bat""", 0, False
sh.Run "cmd /c ""H:\GLM\group-chat\start.bat""", 0, False
sh.Run "cmd /c ""F:\DSH\tools\start-suzheng-serve.bat""", 0, False
Set sh = Nothing
