' UPS Expéditions en mode démo (fausses commandes, aucune étiquette réelle)
Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
CreateObject("WScript.Shell").Run "wscript.exe """ & fso.GetParentFolderName(WScript.ScriptFullName) & "\UPS Expeditions.vbs"" /demo", 0, False
