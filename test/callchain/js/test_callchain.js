const { exec } = require('child_process');
const mysql = require('mysql');

/**
 * Test SQL injection sink detection
 */
function testSqlInjection(userInput) {
    const connection = mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: 'password',
        database: 'test'
    });

    connection.connect();

    // This should be detected as a sink match
    const query = "SELECT * FROM users WHERE name = '" + userInput + "'";
    connection.query(query, function (error, results, fields) {
        if (error) throw error;
        console.log(results);
    });

    connection.end();
}

/**
 * Test command injection sink detection
 */
function testCommandInjection(command) {
    // This should be detected as a sink match
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return;
        }
        console.log(`stdout: ${stdout}`);
        console.error(`stderr: ${stderr}`);
    });
}

/**
 * Test eval sink detection
 */
function testEvalInjection(code) {
    // This should be detected as a sink match
    eval(code);
}

// Main execution
testSqlInjection('admin');
testCommandInjection('ls -la');
testEvalInjection('console.log("test")');
