import os
import sqlite3
import subprocess

def test_sql_injection(user_input):
    """Test SQL injection sink detection"""
    conn = sqlite3.connect('test.db')
    cursor = conn.cursor()

    # This should be detected as a sink match
    query = f"SELECT * FROM users WHERE name = '{user_input}'"
    cursor.execute(query)

    results = cursor.fetchall()
    conn.close()
    return results

def test_command_injection(command):
    """Test command injection sink detection"""
    # This should be detected as a sink match
    result = subprocess.call(command, shell=True)
    return result

def test_os_system(command):
    """Test os.system sink detection"""
    # This should be detected as a sink match
    os.system(command)

def test_eval_injection(code):
    """Test eval sink detection"""
    # This should be detected as a sink match
    eval(code)

if __name__ == '__main__':
    test_sql_injection('admin')
    test_command_injection('ls -la')
    test_os_system('pwd')
    test_eval_injection('print("test")')
