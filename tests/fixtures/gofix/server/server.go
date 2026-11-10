package server

import (
	"fmt"
	"net/http"

	"example.com/gofix/store"
)

type Base struct{ name string }

func (b *Base) Log(msg string) { fmt.Println(b.name, msg) }

type Server struct {
	Base
	St     store.Store
	Handle func()
}

func (s *Server) Serve() {
	s.Log("start")
	defer s.Close()
	go s.worker()
	s.St.Get("x")
	s.Handle()
	http.HandleFunc("/", s.Page)
}

func (s *Server) worker() {}

func (s *Server) Close() {}

func (s *Server) Page(w http.ResponseWriter, r *http.Request) {}
