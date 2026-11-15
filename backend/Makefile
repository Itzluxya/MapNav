CXX := c++
CXXFLAGS := -std=c++20 -O2 -Wall -Wextra -Wpedantic
LDFLAGS :=
ifeq ($(OS),Windows_NT)
  LDFLAGS += -lws2_32
endif
TARGET := bin/navigator_api
SOURCES := src/main.cpp src/routing.cpp

.PHONY: all run clean

all: $(TARGET)

$(TARGET): $(SOURCES) src/routing.hpp
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) $(SOURCES) -o $(TARGET) $(LDFLAGS)

run: $(TARGET)
	./$(TARGET)

clean:
	rm -rf bin
