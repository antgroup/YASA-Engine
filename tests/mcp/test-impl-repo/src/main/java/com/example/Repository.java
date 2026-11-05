package com.example;

public interface Repository<T> {
    T findById(Long id);
}