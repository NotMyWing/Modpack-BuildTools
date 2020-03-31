:: Server Launch Script
::
:: Thrown together by Neeve in under five minutes, Public Domain
:: https://github.com/Neeve01 

:: DO NOT EDIT UNLESS YOU KNOW WHAT YOU'RE DOING
@ECHO OFF
SET FORGEJAR=./forge-1.12.2-14.23.5.2838-universal.jar
SET JAVA_PARAMETERS=

:: these you can edit
SET MIN_RAM=2048M
SET MAX_RAM=2048M

:: DO NOT EDIT ANYTHING PAST THIS LINE
SET LAUNCHPARAMS=-server -Xms%MIN_RAM% -Xmx%MAX_RAM% %JAVA_PARAMETERS% -jar %FORGEJAR% nogui
echo Launching the server...
echo.
echo ^> java %LAUNCHPARAMS%
echo.
java %LAUNCHPARAMS%

echo.
echo ^> The server has stopped. If it's a crash, please read the output above.
echo.
pause