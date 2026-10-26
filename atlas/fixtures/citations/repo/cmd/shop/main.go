package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"

	_ "github.com/lib/pq"

	"example.com/shop/orders"
	"example.com/shop/web"
)

func main() {
	db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}

	service := &orders.Service{DB: db, Mailer: orders.HTTPMailer{Endpoint: os.Getenv("MAIL_URL")}}

	log.Fatal(http.ListenAndServe(":3000", web.Routes(service)))
}
