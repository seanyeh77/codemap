package main

import (
	"example.com/gofix/server"
	"example.com/gofix/store"
)

func process() {}

func main() {
	s := &server.Server{St: store.New(), Handle: process}
	s.Serve()
	var st store.Store = store.New()
	st.Get("a")
	either := store.Pick(true)
	either.Get("b")
	h := process
	h()
	f := func() { process() }
	f()
	(*server.Server).Close(s)
}
