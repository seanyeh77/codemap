package server

import (
	"testing"
	"time"
)

type fakeStore struct{}

func (fakeStore) Get(key string) string { return "fake" }

func TestStamp(t *testing.T) {
	c := NewClocked(func() {})
	c.Now = func() time.Time { return time.Unix(1, 0) }
	c.St = fakeStore{}
	if c.Stamp() != 1 {
		t.Fatal("stamp")
	}
	c.Now()
}
