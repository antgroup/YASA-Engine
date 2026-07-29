package com.example;

public class OuterClass {
    class InnerValidator implements RequestValidator {
        @Override
        public boolean validate(Object request) {
            return true;
        }
    }
}