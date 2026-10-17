@echo off
rem Builds PianoidSandbox.exe with the .NET Framework 4 compiler that ships with Windows (no SDK, no admin).
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize /platform:x64 /out:"%~dp0PianoidSandbox.exe" "%~dp0PianoidSandbox.cs"
