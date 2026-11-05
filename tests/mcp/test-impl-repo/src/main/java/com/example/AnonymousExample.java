package com.example;

public class AnonymousExample {
    public void doSomething() {
        // 匿名实现类
        RequestValidator validator = new RequestValidator() {
            @Override
            public boolean validate(Object request) {
                return false;
            }
        };
    }
}