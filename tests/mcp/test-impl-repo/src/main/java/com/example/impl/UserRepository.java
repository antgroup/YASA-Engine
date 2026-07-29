package com.example.impl;

import com.example.Repository;
import com.example.User;

public class UserRepository implements Repository<User> {
    @Override
    public User findById(Long id) {
        return null;
    }
}