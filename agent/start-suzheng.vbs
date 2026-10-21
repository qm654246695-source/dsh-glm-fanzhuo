' Launch 肃正协议's serve detached (no console window, not a child of the caller).
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c ""F:\DSH\tools\start-suzheng-serve.bat""", 0, False
Set sh = Nothing
