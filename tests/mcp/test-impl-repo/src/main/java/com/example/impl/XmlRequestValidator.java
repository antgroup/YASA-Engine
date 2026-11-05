package com.example.impl;

import com.example.RequestValidator;

public class XmlRequestValidator implements RequestValidator {
    @Override
    public boolean validate(Object request) {
        return true;
    }
}