package com.example;

public interface RequestValidator {
    boolean validate(Object request);

    boolean validate(Object request, String mode);
}