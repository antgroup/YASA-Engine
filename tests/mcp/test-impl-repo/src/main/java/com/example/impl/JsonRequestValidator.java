package com.example.impl;

import com.example.RequestValidator;

public class JsonRequestValidator implements RequestValidator {
    @Override
    public boolean validate(Object request) {
        return true;
    }
}